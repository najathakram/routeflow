import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isLockTimeout } from "../units/tenant-units-lock";
import {
  paymentKeyInFlightConflict,
  withCurrentState,
  type PaymentKeyScope,
} from "./payment-idempotency";

/** The bound on the resolve's wait behind an uncommitted claim (SA-824 race ruling 3). */
const RESOLVE_LOCK_TIMEOUT = "5s";
/** The Prisma transaction outlives the lock wait, so a wait that runs out surfaces as 55P03, not P2028. */
const RESOLVE_TX = { timeout: 15_000, maxWait: 5_000 };

/** The actor of a resolve (the verified JWT payload). */
export interface PaymentKeyActor {
  sub?: string | null;
  impersonatedBy?: string | null;
}

/** A committed key row, as the readers see it. */
interface KeyRow {
  state: string; // a PaymentKeyState; Prisma types it as its enum, raw readers as text
  scope: string | null;
  result: unknown;
  paymentGroupId?: string | null;
  advancePaymentId?: string | null;
}

export type PaymentKeyAnswer =
  | ({ state: "found"; scope: PaymentKeyScope; replayed: true } & Record<string, unknown>)
  | { state: "tombstoned" };

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

/** SQLSTATE 55P03 (the 5 s lock wait ran out) or P2028 (the Prisma transaction did): the payment is in flight. */
const inFlight = (e: unknown) =>
  isLockTimeout(e) || (e as { code?: unknown } | null)?.code === "P2028";

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * SA-824 (SA condition a/b + race ruling): the DEFINITIVE answers about a payment Idempotency-Key, for a
 * dialog whose outcome is unknown (a lost response). Tenant-scoped, one endpoint pair for the three scopes
 * (standalone, per-invoice, direct advance). Every state is explicit (race ruling 2):
 *   COMPLETED  -> { state: "found", <stored result with CURRENT statuses>, scope, replayed: true }
 *   TOMBSTONED -> { state: "tombstoned" } (resolved: nothing was recorded, nothing ever will be)
 *   CLAIMED    -> 409 PAYMENT_KEY_IN_FLIGHT (committed but never settled: not an answer)
 *
 *  - `byKey` (GET) is read-only; no row is 404 PAYMENT_KEY_NOT_FOUND, which the clients do NOT treat as
 *    an answer (an uncommitted claim is invisible to it: race ruling 5).
 *  - `resolve` (POST .../resolve) closes the race: `INSERT ... TOMBSTONED ... ON CONFLICT DO NOTHING` WAITS
 *    behind an uncommitted claim of the same (tenantId, key), at most 5 s. The claim commits -> the conflict
 *    reads its COMPLETED row ("found"); it rolls back -> the tombstone lands ("tombstoned") and a late POST
 *    under the key is refused 409 PAYMENT_KEY_RESOLVED. Timeout -> 409 PAYMENT_KEY_IN_FLIGHT (retryable).
 *    One audit row per answer: actor, the key's sha256 (never the raw key), outcome, invoice/customer id.
 */
@Injectable()
export class PaymentKeyStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private requireTenant(): string {
    // forTenant() is UNSCOPED without a tenant: refuse, like the writers.
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
    }
    return tenantId;
  }

  private readRow(key: string): Promise<KeyRow | null> {
    return this.prisma.forTenant().paymentIdempotencyKey.findFirst({
      where: { key },
      select: {
        state: true,
        scope: true,
        result: true,
        paymentGroupId: true,
        advancePaymentId: true,
      },
    });
  }

  /** A committed row's answer: every state explicit. */
  private async answer(row: KeyRow): Promise<PaymentKeyAnswer> {
    if (row.state === "TOMBSTONED") return { state: "tombstoned" };
    if (row.state !== "COMPLETED" || !row.scope) throw paymentKeyInFlightConflict(); // CLAIMED
    const scope = row.scope as PaymentKeyScope;
    const stored = await withCurrentState(this.prisma, scope, row.result);
    return { state: "found", ...stored, scope, replayed: true as const };
  }

  async byKey(key: string): Promise<PaymentKeyAnswer> {
    this.requireTenant();
    const row = await this.readRow(key);
    if (!row) {
      throw new NotFoundException({
        code: API_ERROR_CODES.PAYMENT_KEY_NOT_FOUND,
        message: "No payment is recorded under this key",
      });
    }
    return this.answer(row);
  }

  async resolve(key: string, actor?: PaymentKeyActor | null): Promise<PaymentKeyAnswer> {
    const tenantId = this.requireTenant();
    const id = randomUUID();
    let inserted: boolean;
    try {
      inserted = await this.prisma.tenantTransaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${RESOLVE_LOCK_TIMEOUT}'`);
        const rows: unknown[] = await tx.$queryRaw`
          INSERT INTO "PaymentIdempotencyKey" ("id", "tenantId", "key", "state", "result")
          VALUES (${id}, ${tenantId}, ${key}, 'TOMBSTONED'::"PaymentIdempotencyState", '{}'::jsonb)
          ON CONFLICT ("tenantId", "key") DO NOTHING
          RETURNING "id"`;
        return rows.length > 0;
      }, RESOLVE_TX);
    } catch (e) {
      if (inFlight(e)) throw paymentKeyInFlightConflict();
      throw e;
    }

    // Not inserted: the conflicting row is COMMITTED (Postgres waited for it), so this read sees it.
    const row = inserted ? null : await this.readRow(key);
    const out: PaymentKeyAnswer = row ? await this.answer(row) : { state: "tombstoned" };
    await this.auditResolve(tenantId, key, out, row, actor);
    return out;
  }

  private async auditResolve(
    tenantId: string,
    key: string,
    out: PaymentKeyAnswer,
    row: KeyRow | null,
    actor?: PaymentKeyActor | null,
  ): Promise<void> {
    const hash = keyHash(key);
    const found = out.state === "found" ? out : null;
    const payments = found?.payments as Array<{ invoiceId?: unknown }> | undefined;
    await this.audit.log({
      tenantId,
      userId: actor?.sub ?? null,
      impersonatedBy: actor?.impersonatedBy ?? null,
      action: AUDIT_ACTIONS.PAYMENT_KEY_RESOLVE,
      entityType: "payment-key",
      entityId: hash,
      meta: {
        keyHash: hash,
        outcome: out.state,
        scope: found?.scope ?? null,
        invoiceId:
          found?.scope === "INVOICE_PAYMENT"
            ? str(found.id)
            : str(Array.isArray(payments) ? payments[0]?.invoiceId : null),
        customerId: str(found?.customerId),
        paymentGroupId: row?.paymentGroupId ?? null,
        advancePaymentId: row?.advancePaymentId ?? null,
      },
    });
  }
}
