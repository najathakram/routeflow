import { roundMoney, sumConfirmed } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import type { DuplicatePaymentRefExisting } from "@routeflow/types";
import { isTender } from "./counter-sale-readback";
import { duplicateCause } from "./counter-duplicate-ref";
import { pickupTenderGroupId } from "./pickup-tender-group";

/**
 * The response figures of POST /orders/:id/pickup-complete, read back from what is STORED. Payment rules
 * (the planner, the oldest-first allocation, the method mapping) are the counter sale's, imported from
 * `counter-sale-payment.ts`; only the question "which stored payments are THIS request's tender?" differs
 * from the counter sale, whose invoices are born in the same request as its tender. A pickup order's invoice
 * pre-exists (deposits, portal payments, an ADVANCE or credit applied by send), so the answer is keyed on
 * THIS completion (SA-919): a tender row of the order's hand-over group created at or after the claim's `completionAt`.
 *
 * No line/tax/total math lives here: only the payment split (in cents via roundMoney).
 */
export type PayRow = {
  id: string;
  amount: unknown;
  method?: string;
  status?: string;
  createdAt?: Date | string | null;
  paymentGroupId?: string | null;
};

export type InvoiceRow = {
  id: string;
  invoiceNumber?: string;
  total: unknown;
  status?: string;
  payments?: PayRow[];
};

/**
 * SA-919: is this stored payment THIS completion's tender? ONE identity, used by every site: a tender row of the order's
 * hand-over group (`pickupTenderGroupId`, written IN the create, SA-763r R7) created at or after the claim's `completionAt`.
 * The group alone is per ORDER (a reopened order's first tender carries it too); the time alone would take a deposit or a
 * portal payment made after the stamp. With no `completionAt` (a legacy claim) or no `createdAt`, EVERY row of the group
 * counts: the unknown direction is "already collected", never a second collection.
 */
export const isHandOverTender =
  (orderId: string, completionAt: Date | null) =>
  (p: PayRow): boolean =>
    isTender(p) &&
    p.paymentGroupId === pickupTenderGroupId(orderId) &&
    (completionAt == null || p.createdAt == null || new Date(p.createdAt) >= completionAt);

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
  duplicate?: DuplicatePaymentRefExisting,
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
      ? {
          paymentErrorCode: planError ?? API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED,
          ...duplicateCause(duplicate),
        }
      : {}),
  };
}
