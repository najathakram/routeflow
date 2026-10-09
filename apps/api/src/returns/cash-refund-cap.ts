/**
 * SA-749r2 item 9 (LEAD RULING, SA-758 CR-1): the cash-refund cap. A cash refund may not exceed the cash APPLIED to that sale
 * minus the cash already refunded on it (409 REFUND_EXCEEDS_CASH_PAID): a split sale paid 40 cash + 60 card can give back at
 * most 40 in cash, whatever the return is worth. It is per SALE (an inline return can span source orders), and both refund
 * paths run it under the Order locks they already hold, before the claim, so two refunds cannot both read the same room.
 *
 * - Cash applied = the PAID CASH payments on the sale's live invoices (not VOID / WRITTEN_OFF). A split sale's cash leg is
 *   stored as the amount actually placed (change excluded), so this is the cash that stayed.
 * - Earlier refunds count when their tender is CASH or UNKNOWN (`Return.refundTender` null): an unknown tender is never
 *   assumed to be card, so the cap fails closed. A card or check refund does not use cash room.
 * - Only a CASH refund is capped (a counter order's refund with NO tender counts as cash). Card and check limits wait for their
 *   own tender reports.
 */
import { ConflictException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { EXTERNAL_REFUND_METHOD, type RefundTender } from "./inline-return-refund";

const DEAD_INVOICE_STATUSES = ["VOID", "WRITTEN_OFF"];
const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** This refund's money per source sale: subtotal + tax + category tax of its items, summed per `sourceOrderId`, rounded to cents. */
export function amountsBySourceOrder(
  items: ReadonlyArray<{
    sourceOrderId?: string | null;
    subtotal?: unknown;
    taxAmount?: unknown;
    categoryTax?: unknown;
  }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (!it.sourceOrderId) continue;
    out.set(
      it.sourceOrderId,
      roundMoney(
        (out.get(it.sourceOrderId) ?? 0) +
          num(it.subtotal) +
          num(it.taxAmount) +
          num(it.categoryTax),
      ),
    );
  }
  return out;
}

/**
 * What THIS refund takes from each sale. A return from ONE sale takes exactly its refund `total` (the server's figure, so the
 * cap and the amount can never disagree by a rounding cent); a return spanning several sales is split by its items' own money.
 */
export function refundAmountsBySale(
  items: Parameters<typeof amountsBySourceOrder>[0],
  total: number,
): Map<string, number> {
  const bySale = amountsBySourceOrder(items);
  if (bySale.size === 1) return new Map([[[...bySale.keys()][0], roundMoney(total)]]);
  return bySale;
}

/** Throws 409 REFUND_EXCEEDS_CASH_PAID when a CASH refund asks for more than a sale's cash room. No-op for any other tender. */
export async function assertCashRefundWithinCap(
  tx: any,
  input: {
    /** this refund's own return: its row is never an "earlier" refund */
    returnId: string;
    tender: RefundTender | null | undefined;
    /**
     * A COUNTER order's refund with no tender is treated as CASH (fail closed, like an earlier refund with an unknown tender):
     * the tender is optional on the server, so without this a clerk could leave it unset and take cash uncapped.
     */
    counterOrder?: boolean;
    /** this refund's amount per sale (source order id -> amount) */
    perOrder: ReadonlyMap<string, number>;
  },
): Promise<void> {
  const asCash = input.tender === "CASH" || (!input.tender && input.counterOrder === true);
  if (!asCash) return;
  const orderIds = [...input.perOrder.keys()].sort();
  if (orderIds.length === 0) return;

  const [payments, earlierInline, earlierStandard]: [any[], any[], any[]] = await Promise.all([
    tx.invoicePayment.findMany({
      where: {
        method: "CASH",
        status: "PAID",
        invoice: { orderId: { in: orderIds }, status: { notIn: DEAD_INVOICE_STATUSES } },
      },
      select: { amount: true, invoice: { select: { orderId: true } } },
    }),
    tx.returnItem.findMany({
      where: {
        sourceOrderId: { in: orderIds },
        return: {
          kind: "INLINE",
          status: "REFUNDED",
          refundMethod: EXTERNAL_REFUND_METHOD,
          id: { not: input.returnId },
          OR: [{ refundTender: null }, { refundTender: "CASH" }],
        },
      },
      select: { sourceOrderId: true, subtotal: true, taxAmount: true, categoryTax: true },
    }),
    tx.return.findMany({
      where: {
        orderId: { in: orderIds },
        kind: "STANDARD",
        status: "REFUNDED",
        refundMethod: EXTERNAL_REFUND_METHOD,
        id: { not: input.returnId },
        OR: [{ refundTender: null }, { refundTender: "CASH" }],
      },
      select: { orderId: true, refundAmount: true },
    }),
  ]);

  const cashPaid = new Map<string, number>();
  for (const p of payments) {
    const orderId = p.invoice?.orderId;
    if (orderId) cashPaid.set(orderId, roundMoney((cashPaid.get(orderId) ?? 0) + num(p.amount)));
  }
  const refunded = amountsBySourceOrder(earlierInline);
  for (const r of earlierStandard) {
    refunded.set(r.orderId, roundMoney((refunded.get(r.orderId) ?? 0) + num(r.refundAmount)));
  }

  for (const orderId of orderIds) {
    const requested = roundMoney(input.perOrder.get(orderId) ?? 0);
    const room = Math.max(
      0,
      roundMoney((cashPaid.get(orderId) ?? 0) - (refunded.get(orderId) ?? 0)),
    );
    if (requested > room + 0.001) {
      throw new ConflictException({
        code: API_ERROR_CODES.REFUND_EXCEEDS_CASH_PAID,
        message:
          `This is more cash than was taken for this sale (less the cash already refunded): at most $${room.toFixed(2)} can ` +
          "go back in cash. Refund the rest by card or check, or give store credit.",
        maxCashRefund: room,
        requested,
      });
    }
  }
}
