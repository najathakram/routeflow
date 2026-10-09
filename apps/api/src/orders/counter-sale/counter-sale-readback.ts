import { InternalServerErrorException } from "@nestjs/common";
import { roundMoney, sumConfirmed } from "@routeflow/pricing";
import type {
  CounterSalePaymentMethod,
  CounterSaleResponse,
  CounterSaleTenderLine,
} from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import type { CounterLegInput } from "./counter-sale-legs";
import { isTender, readStoredTender, type InvoiceRow } from "./counter-sale-tender";

export { isTender, type InvoiceRow };

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
 * - With the request's `legs` (POST): leg 0's method is echoed and the request's own rules apply (a throw
 *   part-way through the allocation is `planError`; `change` comes from the CASH leg's own stored rows
 *   against a fully covered stored balance).
 * - Without them (by-key): the method is DERIVED from storage (first stored tender; none = ON_ACCOUNT, since no
 *   marker separates "left on account" from "tender failed" and nothing new is persisted), a stored tender
 *   that leaves balance owing is NOT recorded (it may be an interrupted allocation), and there is no `change`
 *   (cash tendered is not stored). By-key with the till's `method` passes one amount-less leg.
 *
 * Which stored row belongs to which leg is `readStoredTender`'s rule (the sale's own group ids; a pre-split
 * attempt's ungrouped rows are leg 0's), so an office payment on the same invoice is never the sale's tender.
 */
export function buildCounterSaleResponse(input: {
  legs?: Array<Pick<CounterLegInput, "method" | "amount">>;
  order: { id: string; orderNumber: string | null } | null;
  invoices: InvoiceRow[];
  replayed: boolean;
  planError?: string;
}): CounterSaleResponse {
  const { legs, order, invoices, replayed, planError } = input;
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
  const stored = readStoredTender(order.id, invoices);
  const lowestLeg = [...stored.byLeg.keys()].sort((a, b) => a - b)[0];
  const legZeroRow = (stored.byLeg.get(legs ? 0 : (lowestLeg ?? 0)) ?? [])[0];
  const anyTender = stored.byLeg.size > 0;
  const method: CounterSalePaymentMethod | undefined = legs
    ? legs[0].method
    : legZeroRow
      ? counterMethodOf(legZeroRow.payment.method)
      : "ON_ACCOUNT";

  let settled: boolean;
  let error = planError;
  if (legs) {
    // A throw part-way (a sibling invoice's allocation) can leave an EARLIER invoice's tender stored while
    // balance remains: that must never read as recorded, so a planError beats "a tender exists" (paid and
    // balanceDue still come from storage). A balance that storage shows fully covered is recorded regardless
    // (the loser of a race whose own recordPayment the invoice row lock refused), except for a split: its
    // refusal (the balance moved under the clerk) stands even when credit has covered everything.
    settled =
      legs.length > 1
        ? !planError && (balanceDue <= 0 || anyTender)
        : method === "ON_ACCOUNT" || balanceDue <= 0 || (!planError && anyTender);
  } else {
    settled = method === "ON_ACCOUNT" || balanceDue <= 0;
    if (!settled) error = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
  }

  // Change is handed back ONLY once the STORED balance is fully covered: this call's cash against what its
  // own leg stored is otherwise money still owed (a replay must never read an unpaid sibling's share as
  // change). Only the CASH leg's own rows count; sumConfirmed counts PAID rows, so a voided one is out.
  const cashLeg = legs?.findIndex((l) => l.method === "CASH") ?? -1;
  let change: number | undefined;
  if (legs && cashLeg >= 0 && legs[cashLeg].amount != null && balanceDue <= 0) {
    const cashPaid = sumConfirmed((stored.byLeg.get(cashLeg) ?? []).map((r) => r.payment));
    const owed = roundMoney(legs[cashLeg].amount! - cashPaid);
    if (owed > 0) change = owed;
  }

  // Every leg of the tender in leg order, from STORAGE: the money RECORDED against it (change is not in it)
  // and the rows that hold it. A request leg that recorded nothing (refused, or ON_ACCOUNT) reads amount 0.
  const legCount = Math.max(legs?.length ?? 0, ...[...stored.byLeg.keys()].map((i) => i + 1));
  const lines: CounterSaleTenderLine[] = [];
  for (let i = 0; i < legCount; i++) {
    const rows = stored.byLeg.get(i) ?? [];
    const lineMethod = legs?.[i]?.method ?? counterMethodOf(rows[0]?.payment.method);
    if (!lineMethod || lineMethod === "ON_ACCOUNT") continue; // ON_ACCOUNT takes no money: no line
    lines.push({
      method: lineMethod,
      amount: roundMoney(sumConfirmed(rows.map((r) => r.payment))),
      paymentIds: rows.map((r) => r.payment.id),
    });
  }

  return {
    orderId: order.id,
    orderNumber: order.orderNumber ?? "",
    invoiceId: first.id,
    invoiceNumber: first.invoiceNumber ?? "",
    total,
    paid,
    balanceDue,
    ...(change != null ? { change } : {}),
    ...(legZeroRow ? { paymentId: legZeroRow.payment.id } : {}),
    ...(lines.length > 0 ? { payments: lines } : {}),
    ...(method ? { method } : {}),
    paymentRecorded: settled,
    ...(!settled
      ? { paymentErrorCode: error ?? API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED }
      : {}),
    ...(replayed ? { replayed: true } : {}),
  };
}
