import { Logger } from "@nestjs/common";
import { roundMoney, sumConfirmed, remainingCapacity } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import type { InvoicesService } from "../../invoices/invoices.service";
import {
  allocateOldestFirst,
  planCounterPayment,
  toPrismaMethod,
  type CounterPaymentInput,
} from "./counter-sale-payment";

/**
 * The tender half shared by the counter sale and POST /orders/:id/pickup-complete: record ONE payment
 * against an order's invoices, and read the response figures back from what is STORED. No line/tax/total
 * math: only the payment split (counter-sale-payment.ts, in cents via roundMoney).
 */
export type InvoiceRow = {
  id: string;
  invoiceNumber?: string;
  total: unknown;
  payments?: Array<{ id: string; amount: unknown; method?: string; status?: string }>;
};

/**
 * A payment the counter itself took (cash / card / check): not a credit-note or advance application.
 * scan-ok: draft-payment-not-void — a replay asks "was a tender already recorded?", and a VOIDED one
 * does not count; the counter never writes a DRAFT payment (recordPayment's default status is PAID).
 */
export const isTender = (p: { method?: string; status?: string }) =>
  p.status !== "VOID" && p.method !== "CREDIT_NOTE" && p.method !== "ADVANCE";

/**
 * Records the tender against the invoices' POST-send balance, unless one is already stored (a replay).
 * Returns `attempted` (a payment was tried, so the caller re-reads the invoices) and `planError`
 * (the refusal or failure code, when the payment could not be recorded). Never throws for a payment problem.
 */
export async function recordTender(
  invoices: InvoicesService,
  rows: InvoiceRow[],
  payment: CounterPaymentInput,
  logger: Logger,
  label: string,
): Promise<{ attempted: boolean; planError?: string }> {
  if (payment.method === "ON_ACCOUNT" || rows.some((i) => (i.payments ?? []).some(isTender))) {
    return { attempted: false };
  }
  const balances = rows.map((i) => ({
    id: i.id,
    balance: remainingCapacity(Number(i.total), i.payments),
  }));
  const plan = planCounterPayment({
    method: payment.method,
    amount: payment.amount,
    balance: roundMoney(balances.reduce((s, b) => s + b.balance, 0)),
  });
  if (plan.kind === "refuse") return { attempted: false, planError: plan.code };
  if (plan.kind === "none") return { attempted: false };
  try {
    for (const part of allocateOldestFirst(balances, plan.amount)) {
      await invoices.recordPayment(part.invoiceId, {
        amount: part.amount,
        method: toPrismaMethod(payment.method)!,
        reference: payment.reference,
      } as never);
    }
  } catch (e) {
    logger.warn(`${label}: payment not recorded (${(e as Error)?.message ?? e})`);
    return { attempted: true, planError: API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED };
  }
  return { attempted: true };
}

/** Every figure comes from the stored invoices/payments; `change` is display-only (no money row). */
export function tenderFigures(
  invoices: InvoiceRow[],
  payment: CounterPaymentInput,
  planError: string | undefined,
) {
  const payments = invoices.flatMap((i) => i.payments ?? []);
  const total = roundMoney(invoices.reduce((s, i) => s + Number(i.total), 0));
  const paid = roundMoney(sumConfirmed(payments));
  const balanceDue = Math.max(0, roundMoney(total - paid));
  const method = payment.method;
  const firstTender = payments.find(isTender);
  // Recorded = nothing was asked of the till (on account / nothing owing) or a tender is STORED (a partial
  // included: its balanceDue stays open on purpose).
  const settled = method === "ON_ACCOUNT" || balanceDue <= 0 || !!firstTender;
  // sumConfirmed counts PAID rows only, so a voided cash payment is already out.
  const cashPaid = roundMoney(sumConfirmed(payments.filter((p) => p.method === "CASH")));
  const tendered = payment.amount;
  const owed = tendered != null ? roundMoney(tendered - cashPaid) : 0;
  const change = method === "CASH" && settled && owed > 0 ? owed : undefined;
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
