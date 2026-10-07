import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import type { CounterSalePaymentMethod, CounterSaleResponse } from "@routeflow/types";
import { displayProductName } from "@/lib/product-display";

/**
 * The counter-sale receipt as a pure view model. Line money goes through `computeLineSubtotal` (a boxed line is prorated,
 * never `qty * unitPrice`); the sale's own figures (total / paid / balance / change) are the server's, passed through.
 */

export interface ReceiptLineInput {
  tempId: string;
  name: string;
  unitPrice: number;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
}

/** The business answer of `GET /settings` (only the fields a receipt header reads). */
export interface ReceiptBusinessProfile {
  businessName?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  taxRate?: number;
}

export interface CounterReceiptLine {
  key: string;
  name: string;
  /** "3 × $2.50" or "1 box + 3 pcs × $12.00 per box" */
  detail: string;
  total: number;
}

export interface CounterReceiptModel {
  header: { name: string | null; addressLines: string[]; phone: string | null };
  orderNumber: string;
  invoiceNumber: string;
  invoiceId: string;
  dateLabel: string;
  lines: CounterReceiptLine[];
  cashier: string | null;
  subtotal: number;
  /** server total minus the client subtotal (tax, a re-price, a credit): 0 = hide the row */
  adjustment: number;
  total: number;
  paid: number;
  balanceDue: number;
  onAccount: boolean;
  paymentNotRecorded: boolean;
  showPaid: boolean;
  showBalance: boolean;
  methodLabel: string | null;
  tendered: number | null;
  tenderedAsEntered: boolean;
  change: number | null;
  changeAsEntered: boolean;
}

/** Sign first: a downward reprice reads "-$1.00", never "$-1.00". */
export const formatReceiptMoney = (n: number): string =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

const METHOD_LABEL: Record<CounterSalePaymentMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  ON_ACCOUNT: "On account",
};

const isBoxed = (l: ReceiptLineInput) => (l.unitsPerBox ?? 0) > 1;

function lineDetail(l: ReceiptLineInput): string {
  const price = formatReceiptMoney(l.unitPrice);
  if (!isBoxed(l)) return `${l.qty} × ${price}`;
  const boxes = l.boxes ?? 0;
  const pieces = l.pieces ?? 0;
  const parts = [`${boxes} box${boxes === 1 ? "" : "es"}`];
  if (pieces) parts.push(`${pieces} pcs`);
  return `${parts.join(" + ")} × ${price} per box`;
}

const clean = (s: string | null | undefined): string => (s ?? "").trim();

export function receiptHeader(profile: ReceiptBusinessProfile | null | undefined) {
  const street = clean(profile?.street);
  const cityLine = [
    [clean(profile?.city), clean(profile?.state)].filter(Boolean).join(", "),
    clean(profile?.zip),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    name: clean(profile?.businessName) || null,
    addressLines: [street, cityLine].filter(Boolean),
    phone: clean(profile?.phone) || null,
  };
}

export function buildCounterReceipt(input: {
  receipt: CounterSaleResponse;
  lines: readonly ReceiptLineInput[];
  /** the method the clerk rang, used when the response does not echo one */
  fallbackMethod?: CounterSalePaymentMethod;
  cashier?: string | null;
  /** set only for a recovered cash sale: what the clerk entered (the server stores no cash tendered) */
  enteredTender: number | null;
  profile: ReceiptBusinessProfile | null | undefined;
  now: Date;
}): CounterReceiptModel {
  const { receipt, lines, enteredTender, profile, now } = input;
  const method = receipt.method ?? input.fallbackMethod;
  const paymentNotRecorded = receipt.paymentRecorded === false;
  const onAccount = method === "ON_ACCOUNT" && !paymentNotRecorded;
  const hasTender = !paymentNotRecorded && !onAccount;

  const serverChange = receipt.change != null && receipt.change > 0 ? receipt.change : null;
  let tendered: number | null = null;
  let tenderedAsEntered = false;
  let change: number | null = null;
  let changeAsEntered = false;
  if (hasTender) {
    if (enteredTender != null) {
      tendered = enteredTender;
      tenderedAsEntered = true;
    } else if (method === "CASH") {
      // the server's `paid` is what the invoice absorbed; cash handed over = paid + the change given
      tendered = roundMoney(receipt.paid + (serverChange ?? 0));
    } // card / check: exactly what was charged, which the Paid row already says
    if (serverChange != null) change = serverChange;
    else if (enteredTender != null) {
      const derived = roundMoney(enteredTender - receipt.paid);
      if (derived > 0) {
        change = derived;
        changeAsEntered = true;
      }
    }
  }

  const rows = lines.map((l) => ({
    key: l.tempId,
    name: l.name,
    detail: lineDetail(l),
    total: computeLineSubtotal({
      unitPrice: l.unitPrice,
      qty: l.qty,
      boxes: l.boxes,
      pieces: l.pieces,
      unitsPerBox: l.unitsPerBox,
    }),
  }));
  const subtotal = roundMoney(rows.reduce((sum, r) => sum + r.total, 0));

  return {
    header: receiptHeader(profile),
    orderNumber: receipt.orderNumber,
    invoiceNumber: receipt.invoiceNumber,
    invoiceId: receipt.invoiceId,
    dateLabel: now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    lines: rows,
    cashier: clean(input.cashier) || null,
    subtotal,
    adjustment: roundMoney(receipt.total - subtotal),
    total: receipt.total,
    paid: receipt.paid,
    balanceDue: receipt.balanceDue,
    onAccount,
    paymentNotRecorded,
    showPaid: hasTender,
    showBalance: paymentNotRecorded || onAccount || receipt.balanceDue > 0,
    methodLabel: hasTender && method ? METHOD_LABEL[method] : null,
    tendered,
    tenderedAsEntered,
    change,
    changeAsEntered,
  };
}

/** What a reprint reads from the order (`GET /orders/:id`); only the fields a receipt line needs. */
export interface ReprintOrderLike {
  orderNumber: string;
  total: number;
  lineItems: ReadonlyArray<{
    id: string;
    name?: string | null;
    product?: {
      name: string;
      variantName?: string | null;
      parentProductId?: string | null;
      parent?: { name: string } | null;
    } | null;
    qty: number;
    unitPrice: number;
    unitsPerBox?: number | null;
    boxes?: number | null;
    pieces?: number | null;
    status?: string;
  }>;
}

/** What a reprint reads from the Today's-sales row: the invoice and tender facts the order does not carry. */
export interface ReprintSaleFacts {
  invoiceId: string;
  invoiceNumber: string;
  paid: number;
  balanceDue: number;
  methods: readonly CounterSalePaymentMethod[];
  soldAt: string | Date;
}

/**
 * The reprint's receipt model, built from the stored order. Same shape (and same line math) as `buildCounterReceipt`; the
 * differences are the facts that are never stored: no Tendered, no Change. The date is the sale's own time, not "now".
 */
export function receiptModelFromOrder(input: {
  order: ReprintOrderLike;
  sale: ReprintSaleFacts;
  cashier?: string | null;
  profile: ReceiptBusinessProfile | null | undefined;
}): CounterReceiptModel {
  const { order, sale, profile } = input;
  const rows = order.lineItems
    .filter((l) => l.status !== "CANCELLED")
    .map((l) => {
      const base = clean(l.product ? displayProductName(l.product) : l.name) || clean(l.name);
      const line: ReceiptLineInput = {
        tempId: l.id,
        name: base || "Item",
        unitPrice: l.unitPrice,
        qty: l.qty,
        unitsPerBox: l.unitsPerBox ?? undefined,
        boxes: l.boxes ?? undefined,
        pieces: l.pieces ?? undefined,
      };
      return {
        key: line.tempId,
        name: line.name,
        detail: lineDetail(line),
        total: computeLineSubtotal({
          unitPrice: line.unitPrice,
          qty: line.qty,
          boxes: line.boxes,
          pieces: line.pieces,
          unitsPerBox: line.unitsPerBox,
        }),
      };
    });
  const subtotal = roundMoney(rows.reduce((sum, r) => sum + r.total, 0));
  const tenders = sale.methods.filter((m) => m !== "ON_ACCOUNT");
  const hasTender = tenders.length > 0;
  const onAccount = !hasTender && sale.balanceDue > 0;
  const soldAt = sale.soldAt instanceof Date ? sale.soldAt : new Date(sale.soldAt);
  return {
    header: receiptHeader(profile),
    orderNumber: order.orderNumber,
    invoiceNumber: sale.invoiceNumber,
    invoiceId: sale.invoiceId,
    dateLabel: soldAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    lines: rows,
    cashier: clean(input.cashier) || null,
    subtotal,
    adjustment: roundMoney(order.total - subtotal),
    total: order.total,
    paid: sale.paid,
    balanceDue: sale.balanceDue,
    onAccount,
    paymentNotRecorded: false,
    showPaid: hasTender,
    showBalance: onAccount || sale.balanceDue > 0,
    methodLabel: hasTender ? tenders.map((m) => METHOD_LABEL[m]).join(" + ") : null,
    tendered: null,
    tenderedAsEntered: false,
    change: null,
    changeAsEntered: false,
  };
}
