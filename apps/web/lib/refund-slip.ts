import {
  formatReceiptMoney,
  formatSaleTime,
  receiptHeader,
  type ReceiptBusinessProfile,
} from "./counter-receipt";
import type { Return } from "./api/returns";

/**
 * The refund slip as a pure view model, built from `GET /returns/:id` and the business profile. It carries what the cashier
 * hands over: the header, the return number, the sale it came from, the lines, the total refunded, how it was paid out (a
 * tender, or store credit) and the cashier. Money is the server's recorded `refundAmount`; nothing is re-priced here (an
 * INLINE return's money was resolved at capture).
 */
export interface RefundSlipProfile extends ReceiptBusinessProfile {
  /** The business's own footer text, printed as plain text. */
  receiptFooter?: string | null;
}

export interface RefundSlipLine {
  key: string;
  name: string;
  detail: string;
}

export type RefundSlipPayout =
  | { kind: "TENDER"; label: string; amount: number }
  | { kind: "STORE_CREDIT"; label: string; amount: number }
  | { kind: "NONE" };

export interface RefundSlipModel {
  header: ReturnType<typeof receiptHeader>;
  returnNumber: string;
  /** "Counter sale ORD-1" / "Order ORD-9"; null when the return carries no order. */
  sourceSale: string | null;
  dateLabel: string;
  lines: RefundSlipLine[];
  total: number;
  payout: RefundSlipPayout;
  /** Who PRINTED this copy (the viewer), not who made the refund: a later reprint names whoever prints it. */
  printedBy: string | null;
  footer: string | null;
}

const TENDER_LABEL: Record<string, string> = { CASH: "Cash", CARD: "Card", CHECK: "Check" };
const clean = (s: string | null | undefined): string => (s ?? "").trim();

export function buildRefundSlip(input: {
  ret: Return & { refundTender?: string | null };
  profile: RefundSlipProfile | null | undefined;
  printedBy?: string | null;
  now?: Date;
}): RefundSlipModel {
  const { ret, profile } = input;
  // A refund that is only PENDING (an inline return waiting to be paid out: RECEIVED, EXTERNAL_REFUND, no amount, no refundedAt)
  // has nothing to hand over yet: no payout, never "Refunded $0.00".
  const settled = ret.status === "REFUNDED" && ret.refundAmount != null && !!ret.refundedAt;
  const amount = settled ? (ret.refundAmount as number) : 0;
  const lines = ret.items.map((i) => {
    const price = i.unitPrice != null ? ` × ${formatReceiptMoney(i.unitPrice)}` : "";
    return {
      key: i.id,
      name: clean(i.product?.name) || "Item",
      detail: i.unitPrice != null ? `${i.qty}${price}` : `${i.qty}`,
    };
  });
  let payout: RefundSlipPayout = { kind: "NONE" };
  if (!settled) {
    payout = { kind: "NONE" };
  } else if (ret.refundMethod === "CREDIT_NOTE") {
    const number = clean(ret.creditNote?.creditNoteNumber);
    payout = {
      kind: "STORE_CREDIT",
      label: number ? `Store credit ${number}` : "Store credit",
      amount,
    };
  } else if (ret.refundMethod === "EXTERNAL_REFUND") {
    const tender = ret.refundTender ? TENDER_LABEL[ret.refundTender] : undefined;
    payout = { kind: "TENDER", label: tender ? `Refunded to ${tender}` : "Refunded", amount };
  }
  const order = ret.order;
  const sourceSale = order
    ? `${order.counterSale ? "Counter sale" : "Order"} ${order.orderNumber}`
    : null;
  return {
    header: receiptHeader(profile),
    returnNumber: ret.returnNumber,
    sourceSale,
    dateLabel: formatSaleTime(ret.refundedAt ?? ret.createdAt, profile?.timezone || undefined),
    lines,
    total: amount,
    payout,
    printedBy: clean(input.printedBy) || null,
    footer: clean(profile?.receiptFooter) || null,
  };
}
