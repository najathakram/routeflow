/**
 * The ONE predicate for "which credit notes can send() sweep onto an invoice" — the query half.
 * `CreditNotesService.autoApplyOldestCreditsInTx` selects with it, and the counter sale's walk-in
 * open-credit guard asks the same question with it, so the guard can never be narrower than what the
 * sweep would actually take (L-167: one predicate, two readers).
 *
 * The remaining-balance half (amount - amountUsed > 0.001) cannot be a Prisma column comparison and
 * stays a JS filter at each caller, via {@link hasOpenCreditBalance}.
 */
import { roundMoney, sumConfirmed } from "@routeflow/pricing";

export function autoApplyCandidateWhere(args: {
  customerId: string;
  now: Date;
  excludeCreditNoteIds?: string[];
}) {
  return {
    customerId: args.customerId,
    status: { not: "VOID" as const },
    autoApplyExcluded: false, // SA-436: an operator kept this note out of the sweep
    OR: [{ expiresAt: null }, { expiresAt: { gt: args.now } }],
    ...(args.excludeCreditNoteIds?.length ? { id: { notIn: args.excludeCreditNoteIds } } : {}),
  };
}

/** True when the note still holds spendable balance (the JS half of the open predicate). */
export function hasOpenCreditBalance(note: { amount: unknown; amountUsed: unknown }): boolean {
  return roundMoney(Number(note.amount) - Number(note.amountUsed)) > 0.001;
}

/**
 * The tenant's send-time credit sweep switch (SA-436, `TenantConfig.creditAutoApplyOnSend`, OFF by default; no
 * config row reads as OFF). The ONE reader: `autoApplyOldestCreditsInTx` runs only when it is on, and the
 * counter sale's walk-in open-credit guard only blocks when it is on (when it is off, send() applies nothing).
 */
export async function creditAutoApplyOnSend(
  db: { tenantConfig: { findUnique: (args: any) => Promise<any> } },
  tenantId: string | null,
): Promise<boolean> {
  if (!tenantId) return false;
  const cfg = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { creditAutoApplyOnSend: true },
  });
  return !!cfg?.creditAutoApplyOnSend;
}

/**
 * SA-998: is the order an inline return was captured on "met"? The inline return's own credit note is reserved for ITS
 * carrying order until then (§6.3). Met = the order is gone (no row / CANCELLED), or it has at least one non-VOID
 * invoice and every one of them is fully paid on the CONFIRMED basis (a DRAFT or PENDING payment is not money
 * received). "Not invoiced yet" is NOT met: at order entry the return is captured before any invoice exists, and
 * reading that as met would release the credit onto some other invoice first. Read on whatever client the caller
 * passes (every query is orderId-scoped, so a bare tx is safe).
 */
export async function isCarryingOrderMet(
  db: {
    order: { findFirst: (args: any) => Promise<any> };
    invoice: { findMany: (args: any) => Promise<any[]> };
  },
  orderId: string,
): Promise<boolean> {
  const order = await db.order.findFirst({ where: { id: orderId }, select: { status: true } });
  if (!order) return true; // no such order: nothing left for the credit to wait on
  if (order.status === "CANCELLED") return true;
  const invoices = await db.invoice.findMany({
    where: { orderId, status: { not: "VOID" } },
    include: { payments: true },
  });
  if (invoices.length === 0) return false;
  for (const inv of invoices) {
    const paid = roundMoney(sumConfirmed(inv.payments));
    if (roundMoney(Number(inv.total) - paid) > 0.001) return false;
  }
  return true;
}

/**
 * SA-998: the ONE reader of "the credit notes the send-time sweep may take for this customer", oldest first.
 * `[]` when the tenant's sweep switch is off; otherwise {@link autoApplyCandidateWhere} (not VOID, not excluded,
 * unexpired), with an open balance, minus an inline-return note whose carrying order is not met yet. The sweep
 * (`autoApplyOldestCreditsInTx`) takes its list from it (its per-invoice blocked pairs stay there: a new sale's
 * invoice has none), the two walk-in open-credit guards ask `.length > 0`, and the operator statement's
 * `autoApplyCredit` sums it, so the counter's part-pay cap can never differ from what the server applies.
 * Read-only: pass the tx client inside the sweep, the tenant client everywhere else.
 */
export async function sweepableCredits(
  db: any,
  args: {
    tenantId: string | null;
    customerId: string;
    now: Date;
    excludeCreditNoteIds?: string[];
  },
): Promise<any[]> {
  if (!(await creditAutoApplyOnSend(db, args.tenantId))) return [];
  const candidates = await db.creditNote.findMany({
    where: autoApplyCandidateWhere({
      customerId: args.customerId,
      now: args.now,
      excludeCreditNoteIds: args.excludeCreditNoteIds,
    }),
    orderBy: { createdAt: "asc" },
  });
  const out: any[] = [];
  for (const cn of (candidates ?? []).filter((c: any) => hasOpenCreditBalance(c))) {
    const ret = await db.return.findFirst({
      where: { creditNoteId: cn.id, kind: "INLINE" },
      select: { orderId: true },
    });
    if (ret && !(await isCarryingOrderMet(db, ret.orderId))) continue;
    out.push(cn);
  }
  return out;
}
