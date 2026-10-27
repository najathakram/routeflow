import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  CAPACITY_EPSILON,
  capacityRefusal,
  confirmedRemaining,
  unconfirmedNoLongerFitting,
  type CapacityOverpayPolicy,
} from "@routeflow/pricing";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * W-769 (owner 7b = A; SA-910 Part 2 as SA-922 corrects it): the per-writer half of "real money is never turned away by an
 * unconfirmed row". The policy and the predicate live in @routeflow/pricing; this file is the ONE place the api applies them,
 * so every PAID writer (recordPayment: the invoice page, the till, the hand-over; the office standalone and through it the
 * buyer approval and the captured settle; delivery cash; bookkeeping; updatePayment's confirm / reopen) reaches the same code.
 *
 * Stored value (credit-note and advance applications) never comes here: it stays on capacity (SA-922 answer 3).
 */

type Row = {
  id: string;
  amount: unknown;
  status?: string | null;
  createdAt?: Date | string | null;
};
type Tx = {
  invoicePayment: { findMany(args: unknown): Promise<Row[]> };
  auditLog: { create(args: unknown): Promise<unknown> };
};

/**
 * A write of `amount` in `status` against an invoice: a PAID write takes the writer's real-money policy, an unconfirmed one
 * always REFUSE (#3645). Throws the writer's 400 with the fixed copy, or returns nothing.
 */
export function assertPaymentFits(p: {
  total: number;
  existing: ReadonlyArray<{ amount: unknown; status?: string | null }>;
  amount: number;
  status: string;
  realMoney: Exclude<CapacityOverpayPolicy, "REFUSE">;
}): void {
  const refusal = capacityRefusal({
    total: p.total,
    existing: p.existing as never,
    amount: p.amount,
    status: p.status,
    overpay: p.status === "PAID" ? p.realMoney : "REFUSE",
  });
  if (refusal) throw new BadRequestException(refusal.message);
}

/**
 * SA-862 rule 4 for every writer: CONFIRMING (DRAFT → PAID) or REOPENING (VOID → PAID) a row when the OTHER confirmed money
 * already covers the total is 409 UNCONFIRMED_PAYMENT_SUPERSEDED; any other breach is the EXCEEDS copy (400). `others` are the
 * invoice's other rows.
 */
export function assertConfirmFits(p: {
  total: number;
  others: ReadonlyArray<{ amount: unknown; status?: string | null }>;
  amount: number;
  confirming: boolean;
}): void {
  if (p.confirming && confirmedRemaining(p.total, p.others as never) <= CAPACITY_EPSILON) {
    throw new ConflictException({
      code: API_ERROR_CODES.UNCONFIRMED_PAYMENT_SUPERSEDED,
      message:
        "Real money already covers this invoice. Void this payment or move it to the customer's credit.",
    });
  }
  assertPaymentFits({ ...p, existing: p.others, status: "PAID", realMoney: "CONFIRMED_BASIS" });
}

/**
 * After a PAID write, inside its transaction: the unconfirmed rows this write NEWLY displaced (the ONE predicate, before vs
 * after `writtenId`), and SA-862's PAYMENT_UNCONFIRMED_OVER_RESERVED audit row when there are any. Returns the ids (the
 * captured settle raises its operator alert after commit from them).
 */
export async function flagUnconfirmedOverReserved(
  tx: Tx,
  inv: { id: string; tenantId: string | null; total: unknown },
  writtenId: string,
): Promise<string[]> {
  const p = { tenantId: inv.tenantId, invoiceId: inv.id, total: Number(inv.total), writtenId };
  // scan-ok: draft-payment-not-void - W-769 listing of every live row; the money narrows via the pricing predicate, never this where.
  const rows = await tx.invoicePayment.findMany({
    where: { invoiceId: p.invoiceId, status: { not: "VOID" } },
    select: { id: true, amount: true, status: true, createdAt: true },
  });
  const before = new Set(
    unconfirmedNoLongerFitting(p.total, rows.filter((r) => r.id !== p.writtenId) as never),
  );
  const displaced = unconfirmedNoLongerFitting(p.total, rows as never).filter(
    (id) => id !== p.writtenId && !before.has(id),
  );
  if (displaced.length > 0) {
    await tx.auditLog.create({
      data: {
        tenantId: p.tenantId,
        action: AUDIT_ACTIONS.PAYMENT_UNCONFIRMED_OVER_RESERVED,
        entityType: "invoice",
        entityId: p.invoiceId,
        meta: { invoiceId: p.invoiceId, writtenId: p.writtenId, displaced },
      },
    });
  }
  return displaced;
}

/** updatePayment's capacity check: PAID (a confirm / reopen included) on CONFIRMED money, DRAFT / PENDING on capacity, VOID free. */
export function assertEditFits(p: {
  total: number;
  others: ReadonlyArray<{ amount: unknown; status?: string | null }>;
  amount: number;
  status: string;
  confirming: boolean;
}): void {
  if (p.status === "VOID") return;
  if (p.status === "PAID") return assertConfirmFits(p);
  assertPaymentFits({ ...p, existing: p.others, realMoney: "CONFIRMED_BASIS" });
}

/** The standalone writer's DRAFT allocation: capacity against every live row (a PAID one is never refused by this). */
export async function assertUnconfirmedAllocationFits(
  tx: Tx,
  inv: { id: string; total: unknown },
  amount: number,
  status: string,
): Promise<void> {
  if (status === "PAID") return;
  // scan-ok: draft-payment-not-void - every live row is the capacity basis for an unconfirmed write (#3645).
  const existing = await tx.invoicePayment.findMany({
    where: { invoiceId: inv.id, status: { not: "VOID" } },
  });
  assertPaymentFits({
    total: Number(inv.total),
    existing,
    amount,
    status,
    realMoney: "CONFIRMED_BASIS_ALLOW_OVERPAY",
  });
}

/** The read side (SA-910 Part 2 step 4): every payment row carries `noLongerFits`, derived from the ONE predicate. */
export function withNoLongerFits<
  T extends { total: unknown; payments?: ReadonlyArray<Row> | null },
>(invoice: T): T {
  if (!invoice?.payments) return invoice;
  const flagged = new Set(
    unconfirmedNoLongerFitting(Number(invoice.total), invoice.payments as never),
  );
  return {
    ...invoice,
    payments: invoice.payments.map((p) => ({ ...p, noLongerFits: flagged.has(p.id) })),
  };
}
