import { ConflictException, ForbiddenException } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { toCents } from "@routeflow/pricing";
import { IDEMPOTENCY_KEY_CONFLICT } from "../orders/merge-idempotency";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PaymentKeyScope } from "@routeflow/types";

/**
 * SA-824 (row 661 step 1): the ONE claim-in-transaction helper of the customer money-in writers
 * (`recordStandalonePayment`, `recordPayment`, `createAdvancePayment`). A double submit or a
 * lost-response retry that carries the same `Idempotency-Key` records the money ONCE.
 *
 *  - The claim is the FIRST statement of the writer's own transaction:
 *    `INSERT ... ON CONFLICT ("tenantId","key") DO NOTHING RETURNING "id"` (raw SQL, no caught
 *    P2002, so the transaction is never poisoned). Postgres makes a concurrent duplicate WAIT on
 *    the unique index for the first transaction: if that commits, the conflict is real; if it
 *    rolls back, this claim succeeds.
 *  - Inserted: the writer writes the money, then `settle` stores the result and its ids in the same
 *    transaction. Committed money <=> a committed key.
 *  - Not inserted: the claim throws `PaymentKeyTaken` before any money write, the transaction rolls
 *    back with nothing written, and the stored row answers: the same scope and `requestHash`
 *    replays the stored result (`replayed: true`) with each payment's CURRENT status re-read;
 *    anything else is 409 `IDEMPOTENCY_KEY_CONFLICT` (the orders code).
 *
 * The store is `PaymentIdempotencyKey` (finance), tenant-scoped, no TTL. The scope enum is the seam
 * the AP writers (vendor-bill payments, supplier payments) reuse in the next PR.
 *
 * SA-824 race ruling 1/2: every row carries a distinct `state`. The claim inserts CLAIMED, the settle
 * marks it COMPLETED (the same transaction, so a committed CLAIMED row never exists in normal
 * operation), and POST /invoices/payments/by-key/:key/resolve inserts a TOMBSTONED row when nothing
 * was committed. The replay reads the state FIRST: TOMBSTONED is 409 PAYMENT_KEY_RESOLVED (nothing
 * written, whatever the body: a tombstone has no hash to compare); then a different scope or hash is
 * 409 IDEMPOTENCY_KEY_CONFLICT (unchanged); then a committed CLAIMED row is 409 PAYMENT_KEY_IN_FLIGHT
 * (never a replay of its empty result); only COMPLETED replays.
 */
export type PaymentKeyState = "CLAIMED" | "COMPLETED" | "TOMBSTONED";

/** The fixed copy of a POST on a tombstoned key (SA-824 race ruling 2), shared with the clients. */
export const PAYMENT_KEY_RESOLVED_MESSAGE =
  "This payment attempt was cancelled — nothing was charged. Start a new payment.";

/** 409 PAYMENT_KEY_RESOLVED: the key was resolved to a tombstone; this request wrote nothing. */
export function paymentKeyResolvedConflict(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.PAYMENT_KEY_RESOLVED,
    message: PAYMENT_KEY_RESOLVED_MESSAGE,
  });
}

/** 409 PAYMENT_KEY_IN_FLIGHT: a payment under the key is not completed yet (retryable, not an answer). */
export function paymentKeyInFlightConflict(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.PAYMENT_KEY_IN_FLIGHT,
    message:
      "A payment under this key is still being recorded. Check its status again in a moment.",
  });
}
export type { PaymentKeyScope };

/** What the request hash covers: the normalized body (ruling 3). */
export interface PaymentKeyRequest {
  customerId?: string | null;
  invoiceId?: string | null;
  amount: number;
  method: string;
  paidAt?: string | null;
  reference?: string | null;
  allocations?: ReadonlyArray<{ invoiceId: string; amount: number }>;
  /** DRAFT or PAID (absent = PAID, the writers' default); null for an advance, which has none. */
  status?: string | null;
  bankCharges?: number | null;
  /** The bank landing date (hashed as a date). */
  settledAt?: string | null;
}

/** The hooks a keyed writer runs inside its own money transaction. */
export interface PaymentKeyHooks<T> {
  /** The transaction's FIRST statement. Throws `PaymentKeyTaken` (nothing written) on a held key. */
  claim(tx: any): Promise<void>;
  /** After the money rows, before commit: stores `result` and its ids on the claimed row. */
  settle(tx: any, result: T, refs?: PaymentKeyRefs): Promise<void>;
}

/** Ids a writer hands its `inTx` beside the result (the standalone excess advance). */
export interface PaymentKeyRefs {
  advancePaymentId?: string | null;
}

/** The writer options a key threads through (`idempotencyKey` in, `claim` / `inTx` down). */
export interface KeyedWriterOpts<T> {
  /** SA-824: the normalized `Idempotency-Key` header (`optionalIdempotencyKey`); absent = today. */
  idempotencyKey?: string;
  /** SA-824: run as the FIRST statement of the writer's transaction (set by `withKeyHooks`). */
  claim?: (tx: any) => Promise<void>;
  /** Runs inside the writer's transaction after the money is written, before commit. */
  inTx?: (tx: any, result: T, refs?: PaymentKeyRefs) => Promise<void>;
}

/** Thrown by `claim` when the key is already held: the writer's transaction rolls back unwritten. */
export class PaymentKeyTaken extends Error {
  constructor() {
    super("Idempotency-Key already claimed");
  }
}

export interface PaymentKeyDeps {
  getTenantId(): string | null;
  forTenant(): any;
}

const centsOrNull = (v: number | null | undefined) => (v == null ? null : toCents(v));

/**
 * sha256 of the normalized body: ids, amounts in cents, method, paid DATE, trimmed reference, sorted
 * allocations, status, bank charges in cents and the bank DATE.
 */
export function paymentRequestHash(req: PaymentKeyRequest): string {
  const allocations = (req.allocations ?? [])
    .map((a) => `${a.invoiceId}:${toCents(a.amount)}`)
    .sort();
  const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null);
  const body = {
    customerId: req.customerId ?? null,
    invoiceId: req.invoiceId ?? null,
    amountCents: centsOrNull(req.amount),
    method: req.method,
    paidAt: day(req.paidAt),
    reference: req.reference?.trim() || null,
    allocations,
    // SA-824 review: a DRAFT retried as PAID (or a changed bank date / charge) is a different request.
    status: req.status ?? null,
    bankChargesCents: centsOrNull(req.bankCharges),
    settledAt: day(req.settledAt),
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** The claimed row's ids, read off the writer's result (and the refs it handed `inTx`). */
function keyRefs(scope: PaymentKeyScope, result: any, refs?: PaymentKeyRefs) {
  return {
    paymentGroupId: typeof result?.paymentGroupId === "string" ? result.paymentGroupId : null,
    advancePaymentId:
      scope === "ADVANCE_PAYMENT" ? (result?.id ?? null) : (refs?.advancePaymentId ?? null),
  };
}

/** Thread the hooks into a writer's opts: `claim` first, the key's `settle` after any caller `inTx`. */
export function withKeyHooks<T, O extends KeyedWriterOpts<T>>(
  opts: O | undefined,
  hooks: PaymentKeyHooks<T> | undefined,
): O | undefined {
  if (!hooks) return opts;
  const inner = opts?.inTx;
  return {
    ...(opts as O),
    claim: (tx: any) => hooks.claim(tx),
    inTx: async (tx: any, result: T, refs?: PaymentKeyRefs) => {
      await inner?.(tx, result, refs);
      await hooks.settle(tx, result, refs);
    },
  };
}

/** Overlay each payment's CURRENT status (and the invoice's / advance's live figures) on a stored result. */
export async function withCurrentState(deps: PaymentKeyDeps, scope: PaymentKeyScope, stored: any) {
  const db = deps.forTenant();
  const out = { ...stored };
  if (Array.isArray(out.payments) && out.payments.length > 0) {
    const ids = out.payments.map((p: any) => p?.id).filter(Boolean);
    const live: any[] = await db.invoicePayment.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, checkStatus: true },
    });
    const byId = new Map(live.map((p) => [p.id, p]));
    out.payments = out.payments.map((p: any) => {
      const now = byId.get(p?.id);
      return now ? { ...p, status: now.status, checkStatus: now.checkStatus } : p;
    });
  }
  if (scope === "INVOICE_PAYMENT" && out.id) {
    const inv = await db.invoice.findFirst({
      where: { id: out.id },
      select: { status: true, paidAt: true },
    });
    if (inv) Object.assign(out, { status: inv.status, paidAt: inv.paidAt });
  }
  if (scope === "ADVANCE_PAYMENT" && out.id) {
    const adv = await db.advancePayment.findFirst({
      where: { id: out.id },
      select: { balance: true },
    });
    if (adv) out.balance = adv.balance;
  }
  return out;
}

/** The columns a replay reads (the state first). */
interface StoredKeyRow {
  state: string; // a PaymentKeyState; Prisma types it as its enum, raw readers as text
  scope: string | null;
  requestHash: string | null;
  result: unknown;
}

async function replay(
  deps: PaymentKeyDeps,
  row: StoredKeyRow | null,
  scope: PaymentKeyScope,
  requestHash: string,
) {
  // TOMBSTONED first: it has no scope or hash, so the mismatch check below would misreport it.
  if (row?.state === "TOMBSTONED") throw paymentKeyResolvedConflict();
  if (!row || row.scope !== scope || row.requestHash !== requestHash) {
    throw new ConflictException({
      code: IDEMPOTENCY_KEY_CONFLICT,
      reason: "PAYMENT_MISMATCH",
      message:
        "Idempotency-Key was already used for a different payment request. That payment may already be recorded; this request wrote nothing.",
    });
  }
  if (row.state !== "COMPLETED") throw paymentKeyInFlightConflict(); // CLAIMED: never its empty result
  return { ...(await withCurrentState(deps, scope, row.result)), replayed: true as const };
}

/**
 * Run a customer money-in writer under an optional key. No key: `write()` exactly as today. A key:
 * a held key replays before any work; otherwise `write(hooks)` claims inside its transaction, and a
 * claim lost to a concurrent duplicate (which Postgres made wait for the winner) replays the winner.
 */
export async function withPaymentKey<T>(
  deps: PaymentKeyDeps,
  key: string | undefined,
  scope: PaymentKeyScope,
  req: PaymentKeyRequest,
  write: (hooks?: PaymentKeyHooks<T>) => Promise<T>,
): Promise<T> {
  if (!key) return write();
  const tenantId = deps.getTenantId();
  if (!tenantId) throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
  const requestHash = paymentRequestHash(req);
  const stored = () =>
    deps.forTenant().paymentIdempotencyKey.findFirst({
      where: { key },
      select: { state: true, scope: true, requestHash: true, result: true },
    });

  const held = await stored();
  if (held) return (await replay(deps, held, scope, requestHash)) as T;

  const id = randomUUID();
  try {
    return await write({
      claim: async (tx) => {
        const rows: unknown[] = await tx.$queryRaw`
          INSERT INTO "PaymentIdempotencyKey" ("id", "tenantId", "key", "scope", "requestHash", "state", "result")
          VALUES (${id}, ${tenantId}, ${key}, ${scope}::"PaymentIdempotencyScope", ${requestHash}, 'CLAIMED'::"PaymentIdempotencyState", '{}'::jsonb)
          ON CONFLICT ("tenantId", "key") DO NOTHING
          RETURNING "id"`;
        if (rows.length === 0) throw new PaymentKeyTaken();
      },
      settle: async (tx, result, writerRefs) => {
        const refs = keyRefs(scope, result, writerRefs);
        await tx.$executeRaw`
          UPDATE "PaymentIdempotencyKey"
          SET "state" = 'COMPLETED'::"PaymentIdempotencyState",
              "result" = ${JSON.stringify(result)}::jsonb,
              "paymentGroupId" = ${refs.paymentGroupId},
              "advancePaymentId" = ${refs.advancePaymentId}
          WHERE "id" = ${id} AND "tenantId" = ${tenantId}`;
      },
    });
  } catch (err) {
    if (!(err instanceof PaymentKeyTaken)) throw err;
    return (await replay(deps, await stored(), scope, requestHash)) as T;
  }
}

/** A writer's scope plus its hash input. */
export interface KeyedPayment {
  scope: PaymentKeyScope;
  req: PaymentKeyRequest;
}

/**
 * The service entry point: `withPaymentKey` with the hooks threaded into the writer's opts
 * (`withKeyHooks`). No `opts.idempotencyKey` = `write(opts)` exactly as today.
 */
export function keyedPayment<T, O extends KeyedWriterOpts<T>>(
  deps: PaymentKeyDeps,
  keyed: KeyedPayment,
  opts: O | undefined,
  write: (opts: O | undefined) => Promise<T>,
): Promise<T> {
  return withPaymentKey<T>(deps, opts?.idempotencyKey, keyed.scope, keyed.req, (hooks) =>
    write(withKeyHooks<T, O>(opts, hooks)),
  );
}

/** The keyed request of each writer (the hash input), so the services stay one line per call. */
/** What the standalone and per-invoice hashes add: status (absent = PAID) and the bank fields. */
interface SettlementFields {
  status?: string;
  bankCharges?: number | null;
  settledAt?: string | null;
}
const settlement = (dto: SettlementFields) => ({
  status: dto.status ?? "PAID",
  bankCharges: dto.bankCharges ?? null,
  settledAt: dto.settledAt ?? null,
});

export const standalonePaymentKey = (
  dto: SettlementFields & {
    customerId: string;
    totalAmount: number;
    method: string;
    paidAt?: string;
    reference?: string;
    allocations: ReadonlyArray<{ invoiceId: string; amount: number }>;
  },
): KeyedPayment => ({
  scope: "STANDALONE_PAYMENT",
  req: {
    customerId: dto.customerId,
    amount: dto.totalAmount,
    method: dto.method,
    paidAt: dto.paidAt,
    reference: dto.reference,
    allocations: dto.allocations,
    ...settlement(dto),
  },
});

export const invoicePaymentKey = (
  invoiceId: string,
  dto: SettlementFields & { amount: number; method: string; paidAt?: string; reference?: string },
): KeyedPayment => ({
  scope: "INVOICE_PAYMENT",
  req: {
    invoiceId,
    amount: dto.amount,
    method: dto.method,
    paidAt: dto.paidAt,
    reference: dto.reference,
    ...settlement(dto),
  },
});

export const advancePaymentKey = (
  customerId: string,
  dto: { amount: number; method: string; receivedAt?: string; reference?: string },
): KeyedPayment => ({
  scope: "ADVANCE_PAYMENT",
  req: {
    customerId,
    amount: dto.amount,
    method: dto.method,
    paidAt: dto.receivedAt,
    reference: dto.reference,
  },
});
