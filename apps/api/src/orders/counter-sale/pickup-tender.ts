import { roundMoney, sumConfirmed } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * The response figures of POST /orders/:id/pickup-complete, read back from what is STORED. Payment rules
 * (the planner, the oldest-first allocation, the method mapping) are the counter sale's, imported from
 * `counter-sale-payment.ts`; only the question "which stored payments are THIS request's tender?" differs
 * from the counter sale, whose invoices are born in the same request as its tender. A pickup order's invoice
 * pre-exists (deposits, portal payments, an ADVANCE or credit applied by send), so the answer is keyed on
 * THIS hand-over: only a tender payment created at or after the order's `deliveredAt` (the moment the
 * hand-over moved it to DELIVERED) is this request's.
 *
 * No line/tax/total math lives here: only the payment split (in cents via roundMoney).
 */
export type PayRow = {
  id: string;
  amount: unknown;
  method?: string;
  status?: string;
  createdAt?: Date | string | null;
};

export type InvoiceRow = {
  id: string;
  invoiceNumber?: string;
  total: unknown;
  status?: string;
  payments?: PayRow[];
};

/**
 * A payment taken at the till (cash / card / check): not a credit-note or advance application.
 * scan-ok: draft-payment-not-void — "was a tender already recorded?" is asked of a VOIDED one as "no",
 * and the till never writes a DRAFT payment (recordPayment's default status is PAID).
 */
export const isTender = (p: { method?: string; status?: string }) =>
  p.status !== "VOID" && p.method !== "CREDIT_NOTE" && p.method !== "ADVANCE";

/**
 * Is this stored payment THIS hand-over's tender? A tender created at or after `handedOverAt`. With no
 * known `handedOverAt` (a legacy DELIVERED row) or no `createdAt`, EVERY stored tender counts as this
 * hand-over's: the unknown direction is "already collected", never a second collection.
 */
export const isHandOverTender =
  (handedOverAt: Date | null) =>
  (p: PayRow): boolean =>
    isTender(p) &&
    (handedOverAt == null || p.createdAt == null || new Date(p.createdAt) >= handedOverAt);

/**
 * Every figure comes from the stored invoices/payments; `change` is display-only (no money row). Change is
 * handed back ONLY once the STORED balance is fully covered, and only against what THIS hand-over's tender
 * actually took: a deposit made earlier is not cash this call received, and a tender that left money owing
 * has no change.
 */
export function tenderFigures(
  invoices: InvoiceRow[],
  payment: { method: string; amount?: number },
  mine: (p: PayRow) => boolean,
  planError: string | undefined,
) {
  const payments = invoices.flatMap((i) => i.payments ?? []);
  const total = roundMoney(invoices.reduce((s, i) => s + Number(i.total), 0));
  const paid = roundMoney(sumConfirmed(payments));
  const balanceDue = Math.max(0, roundMoney(total - paid));
  const method = payment.method;
  const handOverTenders = payments.filter(mine);
  const firstTender = handOverTenders[0];
  // Recorded = nothing was asked of the till (on account / nothing owing) or a tender is STORED (a partial
  // included: its balanceDue stays open on purpose). A planError beats "a tender exists": a throw part-way
  // can leave an earlier sibling's tender stored while balance remains, which is not a recorded payment.
  const settled = method === "ON_ACCOUNT" || balanceDue <= 0 || (!planError && !!firstTender);
  // sumConfirmed counts PAID rows only, so a voided cash payment is already out.
  const cashTaken = roundMoney(sumConfirmed(handOverTenders.filter((p) => p.method === "CASH")));
  const owed = payment.amount != null ? roundMoney(payment.amount - cashTaken) : 0;
  const change = method === "CASH" && balanceDue <= 0 && owed > 0 ? owed : undefined;
  return {
    total,
    paid,
    balanceDue,
    ...(change != null ? { change } : {}),
    ...(firstTender ? { paymentId: firstTender.id } : {}),
    paymentRecorded: settled,
    ...(!settled
      ? { paymentErrorCode: planError ?? API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED }
      : {}),
  };
}
