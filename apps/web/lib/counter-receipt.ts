import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import type {
  CounterSalePaymentMethod,
  CounterSaleResponse,
  TodaysSaleMethod,
} from "@routeflow/types";
import { displayProductName } from "@/lib/product-display";
import { COUNTER_BALANCE_CHANGED_COPY, SPLIT_CODES } from "@/lib/counter-split-tender";

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
   * shows the struck original line total and the discount only when the price was LOWERED. Absent on every other line.
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
  /** IANA zone of the business (`GET /settings`): the live receipt reads the sale time in it */
  timezone?: string | null;
  /** SA-762r: the business's receipt footer (`GET /settings` `receiptFooter`; server-stripped). Printed as plain text only. */
  receiptFooter?: string | null;
}

export interface CounterReceiptLine {
  key: string;
  name: string;
  /** "3 × $2.50" or "1 box + 3 pcs × $12.00 per box" */
  detail: string;
  /** trimmed per-line note, or null */
  note: string | null;
  total: number;
  /**
   * POS-5: the line total at the system price, only for a LOWERED line (struck on the receipt); else null. A raised or
   * unchanged price prints plain: the customer never sees a system price below what they were charged.
   */
  original: number | null;
  /** POS-5: money taken off a lowered line (0 for every other line) */
  discount: number;
}

export interface CounterReceiptModel {
  header: { name: string | null; addressLines: string[]; phone: string | null };
  orderNumber: string;
  invoiceNumber: string;
  invoiceId: string;
  dateLabel: string;
  lines: CounterReceiptLine[];
  cashier: string | null;
  /** the lines at their system prices: net lines plus `discounts`, so Subtotal - Discounts + adjustment = Total */
  subtotal: number;
  /** POS-5: the sum of the edited lines' discounts (0 = no `Discounts` row) */
  discounts: number;
  /** the order's tax (live: the settings rate when it explains the whole difference): 0 = hide the Tax row */
  tax: number;
  /** server total minus the net subtotal minus `tax` (a re-price, a credit, regulated tax): 0 = hide the Adjustments row */
  adjustments: number;
  total: number;
  paid: number;
  balanceDue: number;
  onAccount: boolean;
  paymentNotRecorded: boolean;
  showPaid: boolean;
  showBalance: boolean;
  methodLabel: string | null;
  /** Split payment: one line per tender leg (method + amount) when the sale had 2+ legs; empty for a single tender. */
  tenderLines: Array<{ key: string; label: string; amount: number }>;
  /** Fixed explanation under "payment not recorded" when the code says why (the balance fell mid-sale), else null. */
  paymentNotRecordedCopy: string | null;
  tendered: number | null;
  tenderedAsEntered: boolean;
  change: number | null;
  changeAsEntered: boolean;
  /** the sale's single stored tax rate in percent (8.25 = 8.25%), only when it explains `tax`; else null */
  taxRatePercent: number | null;
  /** SA-762r: the customer's name, only for a named customer (null for a walk-in): printed in the receipt's header block */
  customerName: string | null;
  /** SA-762r: the business's receipt footer, trimmed, or null. Plain text: the view renders it as a React text node. */
  footer: string | null;
}

/**
 * The ONE formatter of the Tax row's label, live and reprint alike: "Tax (8.25%)" when one rate explains the tax, else
 * plain "Tax" (a reprint whose rate is unknown, or a rate that does not account for the stored tax).
 */
export const adjustmentLabel = (taxRatePercent: number | null | undefined): string =>
  taxRatePercent == null ? "Tax" : `Tax (${Number(taxRatePercent.toFixed(3))}%)`;

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

/** GET /orders/:id serialises Prisma Decimals as strings ("3.30"): coerce, and treat anything non-numeric as 0. */
const num = (v: unknown): number => Number(v ?? 0) || 0;

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

/** The footer as printed: trimmed; blank = none. (The server already stripped control characters.) */
const receiptFooterOf = (profile: ReceiptBusinessProfile | null | undefined): string | null =>
  clean(profile?.receiptFooter) || null;

export function buildCounterReceipt(input: {
  receipt: CounterSaleResponse;
  lines: readonly ReceiptLineInput[];
  /** the method the clerk rang, used when the response does not echo one */
  fallbackMethod?: CounterSalePaymentMethod;
  cashier?: string | null;
  /** SA-762r: the named customer; omit (or pass a walk-in's null) and no customer line prints */
  customerName?: string | null;
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
  // Split payment: the server lists every leg. A single tender (0 or 1 legs) keeps the one-method receipt exactly as before.
  const legs = hasTender && (receipt.payments?.length ?? 0) > 1 ? (receipt.payments ?? []) : [];
  const isSplit = legs.length > 1;

  const serverChange = receipt.change != null && receipt.change > 0 ? receipt.change : null;
  let tendered: number | null = null;
  let tenderedAsEntered = false;
  let change: number | null = null;
  let changeAsEntered = false;
  if (isSplit) {
    // each leg is on its own line; cash handed over = the cash leg + the change given back
    const cashLeg = legs.find((l) => l.method === "CASH");
    if (serverChange != null) {
      change = serverChange;
      if (cashLeg) tendered = roundMoney(cashLeg.amount + serverChange);
    } else if (enteredTender != null && cashLeg) {
      // a recovered sale (GET by-key never carries change): the cash the clerk entered on the held attempt, as entered
      tendered = enteredTender;
      tenderedAsEntered = true;
      const derived = roundMoney(enteredTender - cashLeg.amount);
      if (derived > 0) {
        change = derived;
        changeAsEntered = true;
      }
    }
  } else if (hasTender) {
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
    const systemTotal = edited ? lineTotal(l, l.tierPrice as number) : null;
    // Only a LOWERED price is shown against the system price; a raised one must not reveal the lower figure.
    const original =
      systemTotal != null && roundMoney(systemTotal - total) > 0 ? systemTotal : null;
    return {
      key: l.tempId,
      name: l.name,
      detail: lineDetail(l),
      note: clean(l.note) || null,
      total,
      original,
      discount: original == null ? 0 : roundMoney(original - total),
    };
  });
  const netSubtotal = roundMoney(rows.reduce((sum, r) => sum + r.total, 0));
  const discounts = roundMoney(rows.reduce((sum, r) => sum + r.discount, 0));
  // The response carries no tax figure, so the live receipt names the settings rate only when it explains the WHOLE
  // difference between the server total and the lines (Tax (8.25%)); anything else prints as Adjustments, never as tax.
  const difference = roundMoney(receipt.total - netSubtotal) || 0; // never -0
  const rate = profile?.taxRate ?? 0;
  const rateExplains =
    rate > 0 && difference !== 0 && difference === roundMoney((netSubtotal * rate) / 100);

  return {
    header: receiptHeader(profile),
    orderNumber: receipt.orderNumber,
    invoiceNumber: receipt.invoiceNumber,
    invoiceId: receipt.invoiceId,
    dateLabel: formatSaleTime(now, profile?.timezone || "UTC"),
    lines: rows,
    cashier: clean(input.cashier) || null,
    subtotal: roundMoney(netSubtotal + discounts),
    discounts,
    tax: rateExplains ? difference : 0,
    adjustments: rateExplains ? 0 : difference,
    total: receipt.total,
    paid: receipt.paid,
    balanceDue: receipt.balanceDue,
    onAccount,
    paymentNotRecorded,
    showPaid: hasTender,
    showBalance: paymentNotRecorded || onAccount || receipt.balanceDue > 0,
    methodLabel: !isSplit && hasTender && method ? METHOD_LABEL[method] : null,
    tenderLines: legs.map((l, i) => ({
      key: `${i}-${l.method}`,
      label: METHOD_LABEL[l.method],
      amount: l.amount,
    })),
    paymentNotRecordedCopy:
      paymentNotRecorded && receipt.paymentErrorCode === SPLIT_CODES.COUNTER_PAYMENT_EXCEEDS_TOTAL
        ? COUNTER_BALANCE_CHANGED_COPY
        : null,
    tendered,
    tenderedAsEntered,
    change,
    changeAsEntered,
    taxRatePercent: rateExplains ? rate : null,
    customerName: clean(input.customerName) || null,
    footer: receiptFooterOf(profile),
  };
}

/** What a reprint reads from the order (`GET /orders/:id`); only the fields a receipt line needs. */
export interface ReprintOrderLike {
  orderNumber: string;
  total: number;
  /** the order's stored tax (`GET /orders/:id`); absent on an old fixture: then nothing is called tax */
  tax?: number | null;
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
  /** cash handed over (the Today's-sales row's `cashTendered`); null/absent on a legacy sale: no Tendered / Change */
  cashTendered?: number | null;
  /** the sale's single stored tax rate in percent (the row's `taxRatePercent`); null/absent: no rate known */
  taxRatePercent?: number | null;
  /** the row's customer name; null/absent for a walk-in (the row's `isWalkIn`): no customer line prints */
  customerName?: string | null;
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

/**
 * "Oct 7, 2026, 11:15 AM" in the given zone (the sale's own zone, not the browser's). The tenant timezone is a free
 * string: a value Intl does not know would throw a RangeError and break the receipt, so it falls back to UTC.
 * An absent zone is UTC too (never the browser's zone, SA-738).
 */
export function formatSaleTime(at: string | Date, timeZone: string = "UTC"): string {
  const d = at instanceof Date ? at : new Date(at);
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: zone,
    }).format(d);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
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
        unitPrice: num(l.unitPrice),
        qty: num(l.qty),
        unitsPerBox: l.unitsPerBox == null ? undefined : num(l.unitsPerBox),
        boxes: l.boxes == null ? undefined : num(l.boxes),
        pieces: l.pieces == null ? undefined : num(l.pieces),
      };
      return {
        key: line.tempId,
        name: line.name,
        detail: lineDetail(line),
        note: null,
        // A reprint shows no discount: the line stores originalPrice and overrideReason, but not the tier price an edit started from.
        original: null,
        discount: 0,
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
  const orderTotal = num(order.total);
  const tax = roundMoney(num(order.tax));
  const adjustments = roundMoney(orderTotal - subtotal - tax) || 0; // never -0
  const rate = sale.taxRatePercent;
  // Name the rate only when it accounts for the stored tax (a re-price or credit must not read as tax); else plain "Tax".
  const taxRatePercent =
    rate != null && tax !== 0 && tax === roundMoney((subtotal * rate) / 100) ? rate : null;
  const cashApplied = roundMoney(
    sale.methods.filter((m) => m.method === "CASH").reduce((sum, m) => sum + m.amount, 0),
  );
  const tendered = sale.cashTendered ?? null;
  return {
    header: receiptHeader(profile),
    orderNumber: order.orderNumber,
    invoiceNumber: sale.invoiceNumber,
    invoiceId: sale.invoiceId,
    dateLabel: formatSaleTime(sale.createdAt, sale.timezone),
    lines: rows,
    cashier: clean(input.cashier) || null,
    subtotal,
    tax,
    adjustments,
    discounts: 0,
    total: orderTotal,
    paid,
    balanceDue,
    onAccount,
    paymentNotRecorded: false,
    showPaid: hasTender,
    showBalance: onAccount || balanceDue > 0,
    methodLabel: hasTender
      ? sale.methods.map((m) => REPRINT_METHOD_LABEL[m.method]).join(" + ")
      : null,
    tenderLines: [],
    paymentNotRecordedCopy: null,
    tendered,
    tenderedAsEntered: false,
    change: tendered == null ? null : Math.max(0, roundMoney(tendered - cashApplied)),
    changeAsEntered: false,
    taxRatePercent,
    customerName: clean(sale.customerName) || null,
    footer: receiptFooterOf(profile),
  };
}
