import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { IdempotencyService } from "../common/idempotency.service";
import { IDEMPOTENCY_KEY_CONFLICT } from "../orders/merge-idempotency";

/**
 * SA-1222 PR-A: the safe PO create. One transaction holds the number, the PO and its lines; an Idempotency-Key
 * replays the same PO; a builder draft (`draftId`) is consumed in the same transaction.
 *
 *  - KEY (primary): a replay of the same key and body returns the first PO, whatever `draftId` it carries (a mirror
 *    that re-created the draft after a committed submit sends the same `_submitKey` with a new id: the stray draft
 *    is cleaned, no second PO). The same key with a different body is 409 IDEMPOTENCY_KEY_CONFLICT.
 *  - DRAFT (cleanup + second tab): `deleteMany` of the caller's own PURCHASE_ORDER draft. Count 0 on a new key means
 *    it was already turned into a PO or deleted: 409 PO_DRAFT_GONE before any PO row is written.
 *  - NUMBER: `findFirst + 1` under `@@unique([tenantId, poNumber])`; a P2002 aborts the transaction, so the whole
 *    transaction runs again once with a fresh read.
 *  - No key and no draftId: the plain create, unchanged. The lock is a key lock only (never `withAdvisoryLock`).
 */
const SCOPE = "poCreate";

interface Stored {
  fingerprint: string;
  poId: string;
}

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
};

/** The request body without `draftId` (the draft is bookkeeping: a re-created draft must not change the fingerprint). */
export function poCreateFingerprint(body: Record<string, unknown>): string {
  const { draftId: _draftId, ...rest } = body;
  return createHash("sha256").update(stable(rest)).digest("hex");
}

const isPoNumberClash = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export async function createPurchaseOrderGuarded<T>(opts: {
  prisma: { tenantTransaction: (fn: (tx: any) => Promise<any>) => Promise<any> };
  idempotency?: IdempotencyService;
  tenantId: string | null;
  userId: string;
  key?: string;
  draftId?: string;
  body: Record<string, unknown>;
  /** Writes the PO and its lines on `tx` (the number is read on `tx` too). */
  write: (tx: any) => Promise<T & { id: string }>;
  /** Reads an already-created PO (a replay) in the response shape. */
  load: (id: string) => Promise<T>;
}): Promise<T> {
  const { idempotency, tenantId, userId, draftId } = opts;
  const key = opts.key?.trim() || undefined;
  const fingerprint = poCreateFingerprint(opts.body);
  const consume = (tx: any) =>
    tx.saleDraft.deleteMany({ where: { id: draftId, userId, kind: "PURCHASE_ORDER" } });

  for (let attempt = 0; ; attempt++) {
    try {
      const out: { poId: string; created?: T } = await opts.prisma.tenantTransaction(
        async (tx: any) => {
          if (key && idempotency) {
            await idempotency.acquireLock(idempotency.hashFor(key, tenantId, SCOPE), tx);
            const hit = await idempotency.check<Stored>(key, tenantId, SCOPE, tx);
            if (hit) {
              if (hit.fingerprint !== fingerprint) {
                throw new ConflictException({
                  code: IDEMPOTENCY_KEY_CONFLICT,
                  message: "That Idempotency-Key was used for a different purchase order.",
                });
              }
              if (draftId) await consume(tx); // a re-created draft of a PO that already exists
              return { poId: hit.poId };
            }
          }
          if (draftId) {
            const { count } = await consume(tx);
            if (count === 0) {
              throw new ConflictException({
                code: API_ERROR_CODES.PO_DRAFT_GONE,
                message: "This draft was already turned into a PO or deleted.",
              });
            }
          }
          const po = await opts.write(tx);
          if (key && idempotency) {
            await idempotency.save(key, tenantId, SCOPE, { fingerprint, poId: po.id }, tx);
          }
          return { poId: po.id, created: po };
        },
      );
      return out.created ?? (await opts.load(out.poId));
    } catch (err) {
      if (attempt === 0 && isPoNumberClash(err)) continue; // a concurrent create took the number
      throw err;
    }
  }
}
