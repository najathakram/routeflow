import { InternalServerErrorException } from "@nestjs/common";
import { roundMoney, sumConfirmed } from "@routeflow/pricing";
import type { CounterSalePaymentMethod, CounterSaleResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import type { CounterSaleDto } from "./counter-sale.dto";

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
 * SA-764: the change a reprint shows, from STORAGE alone: the stored cash tendered less the sale's OWN original
 * counter-tender CASH rows (the shared `isTender`: never a credit-note / advance application, never a voided
 * row, never "today's cash" or a method roll-up), so later rows can not move it. null when nothing was
 * tendered or no cash tender exists. Not clamped; every figure is rounded to the cent.
 */
export function storedChange(
  tendered: unknown,
  payments: Array<{ amount: unknown; method?: string; status?: string }>,
): number | null {
  if (tendered == null) return null;
  const cash = payments.filter((p) => isTender(p) && p.method === "CASH");
  if (cash.length === 0) return null;
  const cashTotal = roundMoney(cash.reduce((sum, p) => sum + Number(p.amount), 0));
  return roundMoney(roundMoney(Number(tendered)) - cashTotal);
}

/** The counter method of a stored tender (Prisma CREDIT_CARD reads back as CARD); undefined for any other. */
export function counterMethodOf(
  prismaMethod: string | undefined,
): CounterSalePaymentMethod | undefined {
  if (prismaMethod === "CASH") return "CASH";
  if (prismaMethod === "CREDIT_CARD") return "CARD";
  if (prismaMethod === "CHECK") return "CHECK";
  return undefined;
}

/**
 * The ONE read-back of a counter sale (L-167): the POST response and GET .../by-key/:key are both built
 * here, from STORED invoices and payments, so a recovered sale reads exactly like the call that rang it.
 *
 * - With the request's `payment` (POST): that method is echoed and the request's own rules apply (a throw
 *   part-way through the allocation is `planError`; `change` comes from this tender against a fully covered
 *   stored balance).
 * - Without it (by-key): the method is DERIVED from storage (first stored tender; none = ON_ACCOUNT, since no
 *   marker separates "left on account" from "tender failed" and nothing new is persisted), a stored tender
 *   that leaves balance owing is NOT recorded (it may be an interrupted allocation), and there is no `change`
 *   (the response-only `change` needs this call's tender; the stored `cashTendered` is returned instead).
 */
export function buildCounterSaleResponse(input: {
  payment?: CounterSaleDto["payment"];
  order: { id: string; orderNumber: string | null; counterCashTendered?: unknown } | null;
  invoices: InvoiceRow[];
  replayed: boolean;
  planError?: string;
}): CounterSaleResponse {
  const { payment, order, invoices, replayed, planError } = input;
  const first = invoices[0];
  if (!order || !first) {
    throw new InternalServerErrorException(
      "The sale was created but its invoice could not be found. Open the order from the orders list.",
    );
  }
  const payments = invoices.flatMap((i) => i.payments ?? []);
  const total = roundMoney(invoices.reduce((s, i) => s + Number(i.total), 0));
  const paid = roundMoney(sumConfirmed(payments));
  const balanceDue = Math.max(0, roundMoney(total - paid));
  const firstTender = payments.find(isTender);
  const method: CounterSalePaymentMethod | undefined = payment
    ? payment.method
    : firstTender
      ? counterMethodOf(firstTender.method)
      : "ON_ACCOUNT";

  let settled: boolean;
  let error = planError;
  if (payment) {
    // A throw part-way (a sibling invoice's allocation) can leave an EARLIER invoice's tender stored while
    // balance remains: that must never read as recorded, so a planError beats "a tender exists" (paid and
    // balanceDue still come from storage). A balance that storage shows fully covered is recorded regardless
    // (the loser of a race whose own recordPayment the invoice row lock refused).
    settled = method === "ON_ACCOUNT" || balanceDue <= 0 || (!planError && !!firstTender);
  } else {
    settled = method === "ON_ACCOUNT" || balanceDue <= 0;
    if (!settled) error = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
  }

  // sumConfirmed counts PAID rows only, so a voided cash payment is already out.
  const cashPaid = roundMoney(sumConfirmed(payments.filter((p) => p.method === "CASH")));
  const tendered = payment?.amount;
  const owed = tendered != null ? roundMoney(tendered - cashPaid) : 0;
  // Change is handed back ONLY once the STORED balance is fully covered: this call's tender against stored
  // cash is otherwise money still owed (a replay must never read an unpaid sibling's share as change).
  const stored = storedChange(order.counterCashTendered, payments);
  const change =
    method === "CASH" && balanceDue <= 0 ? (stored ?? (owed > 0 ? owed : undefined)) : undefined;

  return {
    orderId: order.id,
    orderNumber: order.orderNumber ?? "",
    invoiceId: first.id,
    invoiceNumber: first.invoiceNumber ?? "",
    total,
    paid,
    balanceDue,
    ...(change != null ? { change } : {}),
    ...(firstTender ? { paymentId: firstTender.id } : {}),
    ...(method ? { method } : {}),
    paymentRecorded: settled,
    ...(!settled
      ? { paymentErrorCode: error ?? API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED }
      : {}),
    ...(order.counterCashTendered != null
      ? { cashTendered: roundMoney(Number(order.counterCashTendered)) }
      : {}),
    ...(replayed ? { replayed: true } : {}),
  };
}
