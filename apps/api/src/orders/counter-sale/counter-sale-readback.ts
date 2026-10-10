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
 * A counter-tender CASH row: the shared `isTender` (never voided, never a credit-note / advance application)
 * that is cash. The ONE definition behind both "does a CASH tender already anchor the stored tendered?" (the
 * tender write) and "which rows is the change measured against?" (the read-back).
 */
export const isCounterTenderCashRow = (p: { method?: string; status?: string }) =>
  isTender(p) && p.method === "CASH";

/**
 * SA-764: the change a reprint shows, from STORAGE alone: the stored cash tendered less the sale's OWN original
 * counter-tender CASH rows (`isCounterTenderCashRow`, summed with `sumConfirmed`: PAID rows only, never "today's
 * cash" or a method roll-up), so later rows can not move it. null when nothing was tendered, no cash tender
 * exists, or the result is negative (later cash on the sale, a shortfall replay): a negative change is never
 * served. Every figure is rounded to the cent.
 */
export function storedChange(
  tendered: unknown,
  payments: Array<{ amount: unknown; method?: string; status?: string }>,
): number | null {
  if (tendered == null) return null;
  const cash = payments.filter(isCounterTenderCashRow);
  if (cash.length === 0) return null;
  const change = roundMoney(roundMoney(Number(tendered)) - roundMoney(sumConfirmed(cash)));
  return change < 0 ? null : change;
}

/**
 * The ONE gate on serving change, shared by the POST / by-key read-back and the Today's-sales row so the two
 * can not drift: only a sale whose FIRST stored tender is CASH (the method the read-back derives from storage)
 * and that has nothing left to pay (`balanceDue <= 0`) serves a change, and then it is `storedChange`; else null.
 */
export function servedChange(
  tendered: unknown,
  payments: Array<{ amount: unknown; method?: string; status?: string }>,
  balanceDue: number,
): number | null {
  const firstTender = payments.find(isTender);
  if (!firstTender || counterMethodOf(firstTender.method) !== "CASH") return null;
  if (balanceDue > 0) return null;
  return storedChange(tendered, payments);
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
 *   part-way through the allocation is `planError`).
 * - Without it (by-key): the method is DERIVED from storage (first stored tender; none = ON_ACCOUNT, since no
 *   marker separates "left on account" from "tender failed" and nothing new is persisted), a stored tender
 *   that leaves balance owing is NOT recorded (it may be an interrupted allocation).
 * - Both: `change` is `servedChange` of the STORED tendered (CASH sale, nothing left to pay), never this call's request.
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

  // Change is handed back ONLY for a CASH sale whose STORED balance is fully covered (a replay must never read
  // an unpaid sibling's share as change); the same gate the Today's-sales row uses.
  const change = servedChange(order.counterCashTendered, payments, balanceDue);

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
