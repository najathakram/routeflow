import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import type {
  CounterSalePaymentMethod,
  CounterSaleResponse,
  TodaysSaleMethod,
} from "@routeflow/types";
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
  /** POS-3: the cashier's optional per-line note, printed under the line. */
  note?: string | null;
  /**
   * POS-5: an edited line (`unitPrice` is then the NET price) carries the system price it was rung at; the receipt
   * shows the struck original line total and the discount. Absent on every other line.
   */
  tierPrice?: number;
  override?: object | null;
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
  /** trimmed per-line note, or null */
  note: string | null;
  total: number;
  /** POS-5: the line total at the system price, only for an edited line (struck on the receipt); else null */
  original: number | null;
  /** POS-5: money taken off an edited line (0 for a raised price and for every plain line) */
  discount: number;
  /** POS-5: an edited line priced at or above the system price (`Price changed`) */
  priceChanged: boolean;
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
  /** POS-5: the sum of the edited lines' discounts (0 = no `Discounts` row) */
  discounts: number;
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

  const lineTotal = (l: ReceiptLineInput, unitPrice: number) =>
    computeLineSubtotal({
      unitPrice,
      qty: l.qty,
      boxes: l.boxes,
      pieces: l.pieces,
      unitsPerBox: l.unitsPerBox,
    });
  const rows = lines.map((l) => {
    const total = lineTotal(l, l.unitPrice);
    const edited = !!l.override && l.tierPrice != null;
    const original = edited ? lineTotal(l, l.tierPrice as number) : null;
    return {
      key: l.tempId,
      name: l.name,
      detail: lineDetail(l),
      note: clean(l.note) || null,
      total,
      original,
      discount: original == null ? 0 : Math.max(0, roundMoney(original - total)),
      priceChanged: original != null && roundMoney(original - total) <= 0,
    };
  });
  const subtotal = roundMoney(rows.reduce((sum, r) => sum + r.total, 0));
  const discounts = roundMoney(rows.reduce((sum, r) => sum + r.discount, 0));

  return {
    header: receiptHeader(profile),
    orderNumber: receipt.orderNumber,
    invoiceNumber: receipt.invoiceNumber,
    invoiceId: receipt.invoiceId,
    dateLabel: now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    lines: rows,
    cashier: clean(input.cashier) || null,
    subtotal,
    discounts,
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
  /** the server's figures, used as given */
  paid: number;
  balanceDue: number;
  methods: ReadonlyArray<{ method: ReprintTender; amount: number }>;
  createdAt: string | Date;
  /** IANA zone the sale time is read in (the server's `meta.timezone`) */
  timezone?: string;
}

/** The tender of a today's-sales row (the shared POS-7b-1 type; never hand-typed here). */
export type ReprintTender = TodaysSaleMethod;

const REPRINT_METHOD_LABEL: Record<ReprintTender, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  OTHER: "Other",
  STORE_CREDIT: "Store credit",
};

/** "Oct 7, 2026, 11:15 AM" in the given zone (the sale's own zone, not the browser's). */
export function formatSaleTime(at: string | Date, timeZone?: string): string {
  const d = at instanceof Date ? at : new Date(at);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(d);
}

/**
 * The reprint's receipt model, built from the stored order. Same shape (and same line math) as `buildCounterReceipt`; the
 * differences are the facts that are never stored: no Tendered, no Change. The date is the sale's own time, not "now".
 */
export function receiptModelFromOrder(input: {
  order: ReprintOrderLike;
  sale: ReprintSaleFacts;
  /** Omit on a reprint: the Order stores no creator, so the original cashier is unknown. */
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
        note: null,
        // A reprint is built from the stored order, which keeps only the net price: no struck original.
        original: null,
        discount: 0,
        priceChanged: false,
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
  const hasTender = sale.methods.length > 0;
  const { paid, balanceDue } = sale;
  const onAccount = !hasTender && balanceDue > 0;
  return {
    header: receiptHeader(profile),
    orderNumber: order.orderNumber,
    invoiceNumber: sale.invoiceNumber,
    invoiceId: sale.invoiceId,
    dateLabel: formatSaleTime(sale.createdAt, sale.timezone),
    lines: rows,
    cashier: clean(input.cashier) || null,
    subtotal,
    adjustment: roundMoney(order.total - subtotal),
    discounts: 0,
    total: order.total,
    paid,
    balanceDue,
    onAccount,
    paymentNotRecorded: false,
    showPaid: hasTender,
    showBalance: onAccount || balanceDue > 0,
    methodLabel: hasTender
      ? sale.methods.map((m) => REPRINT_METHOD_LABEL[m.method]).join(" + ")
      : null,
    tendered: null,
    tenderedAsEntered: false,
    change: null,
    changeAsEntered: false,
  };
}
