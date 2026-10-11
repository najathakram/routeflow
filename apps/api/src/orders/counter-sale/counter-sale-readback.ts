import { InternalServerErrorException } from "@nestjs/common";
import { counterChange, roundMoney, storedTaxRatePercent, sumConfirmed } from "@routeflow/pricing";
import type {
  CounterSalePaymentMethod,
  CounterSaleResponse,
  CounterSaleTenderLine,
} from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import type { CounterLeg } from "./counter-sale-legs";
import { isTender, readStoredTender, type InvoiceRow } from "./counter-sale-tender";
import { counterTenderCashRows, tenderTakenCents } from "./counter-tender-row";

export { isTender, type InvoiceRow };

type PayRow = {
  amount: unknown;
  method?: string;
  status?: string;
  paymentGroupId?: string | null;
};

/**
 * SA-764 + SA-749r2: the change every surface shows, from STORAGE alone. The ONE gate shared by the POST / by-key
 * read-back, the Today's-sales row and the receipt document so they can not drift, and the formula is pricing's
 * `counterChange` (no second one anywhere). `tendered` is `Order.counterCashTendered`, the CASH LEG's handed-over amount
 * whichever leg index it is. The cash APPLIED is what the sale's own counter-tender CASH rows hold
 * (`counterTenderCashRows`, the set-level tender rule, PAID rows only): that stored row, never `total - other methods`, so a
 * card row voided later or a total cut later can not move a past sale's change. (That is `counterChange` with
 * `nonCashApplied = total - cash rows`; the total cancels.) null when nothing was tendered or the sale has no cash tender
 * row (a card-only sale). There is no first-tender gate (a card-first split serves change).
 *
 * A POSITIVE change is served only when the tender COMPLETED at the time (`tenderTakenCents`: the sale's tender rows,
 * voided ones included, reached `total`): the cash handed over beyond a half-written tender is money still owed, not change
 * (an interrupted cash leg across sibling invoices, 20 of 50 recorded, serves null). A later void or total cut does not
 * reopen a completed tender. Change 0 needs no such proof. The cash APPLIED (a payment row) is what the till counts,
 * never `tendered`.
 */
export function servedChange(
  orderId: string,
  tendered: unknown,
  payments: PayRow[],
  total: number,
): number | null {
  if (servedTendered(orderId, tendered, payments) == null) return null;
  const cash = counterTenderCashRows(orderId, payments);
  const cashApplied = roundMoney(sumConfirmed(cash));
  const { change } = counterChange({
    total: cashApplied,
    nonCashApplied: 0,
    tendered: Number(tendered),
  });
  if (change > 0 && tenderTakenCents(orderId, payments) < Math.round(roundMoney(total) * 100)) {
    return null;
  }
  return change;
}

/**
 * Row 347 item 2: the cash handed over a surface may SHOW, from STORAGE alone: the ONE gate shared by the POST / by-key
 * response, the Today's-sales row, the receipt (reprint) and the e-mailed receipt, so the figure and the change can not
 * disagree. `Order.counterCashTendered` is written BEFORE any money moves, so an attempt that died after that write (read
 * by-key, or retried as ON_ACCOUNT, which takes no tender lock and runs no tender step) leaves a figure no money backs: it is
 * served only while the sale has a counter-tender CASH row (`counterTenderCashRows`, the set `servedChange` measures the
 * change against). Null when nothing is stored or no such row exists (a card-only retry, a voided cash row, a foreign one).
 * A sale whose cash row exists serves the figure as before even when tendered exceeds what the row applied, and even for an
 * interrupted tender (whose change stays null: `servedChange`'s own rule).
 */
export function servedTendered(
  orderId: string,
  tendered: unknown,
  payments: PayRow[],
): number | null {
  if (tendered == null) return null;
  if (counterTenderCashRows(orderId, payments).length === 0) return null;
  return roundMoney(Number(tendered));
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
 * - With the request's `legs` (POST): leg 0's method is echoed and the request's own rules apply (a throw
 *   part-way through the allocation is `planError`).
 * - Without them (by-key): the method is DERIVED from storage (first stored tender; none = ON_ACCOUNT, since no
 *   marker separates "left on account" from "tender failed" and nothing new is persisted), a stored tender
 *   that leaves balance owing is NOT recorded (it may be an interrupted allocation). By-key with the till's
 *   `method` passes one amount-less leg.
 * - Both: `change` is `servedChange` of the STORED tendered (a sale with a cash tender and nothing left to
 *   pay), never this call's request.
 *
 * Which stored row belongs to which leg is `readStoredTender`'s rule (the sale's own group ids; a pre-split
 * attempt's ungrouped rows are leg 0's), so an office payment on the same invoice is never the sale's tender.
 */
export function buildCounterSaleResponse(input: {
  legs?: ReadonlyArray<Pick<CounterLeg, "method" | "amount">>;
  order: {
    id: string;
    orderNumber: string | null;
    counterCashTendered?: unknown;
    /** `Order.tax`: served with the rate so the live receipt splits Tax from Adjustments like the reprint */
    tax?: unknown;
  } | null;
  invoices: InvoiceRow[];
  replayed: boolean;
  planError?: string;
  /** the tenant's configured rate in percent: a stored line rate is named only when it equals this */
  configuredTaxPercent?: number | null;
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
    // (the loser of a race: its lock timed out or its own recordPayment was refused after the winner finished).
    // The one exception is a split's over-cover refusal: the balance moved under the clerk, so it stands even
    // when credit has covered everything.
    const refusedOverCover =
      legs.length > 1 && planError === API_ERROR_CODES.COUNTER_PAYMENT_EXCEEDS_TOTAL;
    settled =
      method === "ON_ACCOUNT" ||
      (!refusedOverCover && (balanceDue <= 0 || (!planError && anyTender)));
  } else {
    settled = method === "ON_ACCOUNT" || balanceDue <= 0;
    if (!settled) error = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
  }

  // Change comes from the STORED cash handed over and the sale's own cash rows (`servedChange`, pricing's
  // `counterChange`): the same figure the Today's-sales row and the receipt serve. A response that says the payment was
  // NOT recorded (live or by-key) carries none; `servedChange` itself withholds a positive change for an interrupted tender.
  const change = settled
    ? servedChange(order.id, order.counterCashTendered, payments, total)
    : null;

  // The cash handed over, through the same gate as the change: a figure no counter-tender cash row backs is not served
  const cashTendered = servedTendered(order.id, order.counterCashTendered, payments);

  // Every leg of the tender in leg order, from STORAGE: the money RECORDED against it (change is not in it)
  // and the rows that hold it. A request leg that recorded nothing (refused, or ON_ACCOUNT) reads amount 0.
  const legCount = Math.max(legs?.length ?? 0, ...[...stored.byLeg.keys()].map((i) => i + 1));
  const lines: CounterSaleTenderLine[] = [];
  for (let i = 0; i < legCount; i++) {
    const rows = stored.byLeg.get(i) ?? [];
    // The STORED method wins whenever a row exists: a by-key `?method` hint is only the till's guess
    const lineMethod = counterMethodOf(rows[0]?.payment.method) ?? legs?.[i]?.method;
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
    ...(cashTendered != null ? { cashTendered } : {}),
    // ONE home for the rate (pricing): the same candidate the Today's row and the emailed receipt use
    ...(order.tax != null
      ? {
          tax: roundMoney(Number(order.tax)),
          taxRatePercent: storedTaxRatePercent(
            invoices.map((i) => ({ lines: i.items ?? [] })),
            input.configuredTaxPercent,
          ),
        }
      : {}),
    // the stored lines' price facts, so the live receipt applies the invoices' own original-price rule (not the cart's tier price)
    lines: invoices.flatMap((i) =>
      (i.items ?? []).map((l) => ({
        productId: l.productId ?? null,
        unitPrice: roundMoney(Number(l.unitPrice ?? 0)),
        originalPrice: l.originalPrice == null ? null : roundMoney(Number(l.originalPrice)),
        priceType: l.priceType ?? "STANDARD",
      })),
    ),
    ...(replayed ? { replayed: true } : {}),
  };
}
