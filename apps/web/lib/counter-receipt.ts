import {
  dayCloseDateLabel,
  explainedTaxRatePercent,
  formatReceiptMoney,
  receiptFigures,
  receiptLineAmounts,
  receiptLineDetail,
  roundMoney,
  taxRowLabel,
} from "@routeflow/pricing";
import type {
  CounterSalePaymentMethod,
  CounterSaleResponse,
  ReceiptLine,
  ReceiptModel,
  TodaysSaleMethod,
  TodaysSaleReturnResolution,
} from "@routeflow/types";
import { displayProductName } from "./product-display";

/**
 * The counter-sale receipt as a pure view model. Line money goes through pricing's `receiptLineAmounts` (a boxed line is prorated,
 * never `qty * unitPrice`); the sale's own figures (total / paid / balance / change) are the server's, passed through.
 */

export interface ReceiptLineInput {
  tempId: string;
  /** the product sold: matches the cart line to the stored line the response serves */
  productId?: string;
  name: string;
  unitPrice: number;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  /** Row 298: the product's own selling unit ("each", "lb"); printed after the price of a plain line. Absent: no word. */
  unit?: string | null;
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
  /** the tenant's `invoice.hideOriginalPrice` (`GET /settings`): no struck list price and no Discounts row */
  hideOriginalPrice?: boolean;
}

/**
 * The receipt line and model are the SHARED ones (`packages/types/api/receipt.ts`, SA-751r): the print view and the email
 * renderer (`apps/api/src/documents`) render the same type, so a figure can never be in one and not the other. The tax split and
 * the rule for naming a rate are `@routeflow/pricing`'s (`explainedTaxRatePercent`), shared with the emailed receipt.
 */
export type CounterReceiptLine = ReceiptLine;
/**
 * The reprint of a sale that had a return also carries `returned` (the amount, positive; absent or null when nothing was) and
 * `returnedLabel`: the view prints `Returned −$x`, or `Refunded −$x` when every return went out as a refund. Only a server that
 * sends the tender split (`ReprintSaleFacts.tenderPaid`) sets them; an older one reprints exactly as before.
 */
export type CounterReceiptModel = ReceiptModel & {
  returned?: number | null;
  returnedLabel?: "Returned" | "Refunded";
};

/**
 * The ONE formatter of the Tax row's label, live and reprint alike: "Tax (8.25%)" when one rate explains the tax, else
 * plain "Tax" (a reprint whose rate is unknown, or a rate that does not account for the stored tax).
 */
export const adjustmentLabel = taxRowLabel;

/** Sign first: a downward reprice reads "-$1.00", never "$-1.00". The ONE formatter (pricing), shared with the emailed receipt. */
export { formatReceiptMoney };

const METHOD_LABEL: Record<CounterSalePaymentMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  ON_ACCOUNT: "On account",
};

/** "3 × $2.50 each" or "1 box + 3 pcs × $12.00 per box": the ONE text (pricing's `receiptLineDetail`), the same the email prints. */
const lineDetail = (l: ReceiptLineInput): string => receiptLineDetail(l);

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

/**
 * The ONE rule for the receipt's customer name, shared by the live receipt and the reprint: nothing for no customer or
 * the system walk-in record (`isWalkIn`), else the trimmed business name.
 */
export function receiptCustomerName(
  customer: { businessName?: string | null; isWalkIn?: boolean | null } | null | undefined,
): string | null {
  if (!customer || customer.isWalkIn) return null;
  return clean(customer.businessName) || null;
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

  // The server's served change is shown as given: null/absent = no Change row, 0 = a Change $0.00 row (exact cash).
  const serverChange = receipt.change ?? null;
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
    // As-entered fallback ONLY for a paid sale the server stored no tender for (a recovered or legacy cash sale). A stored
    // tender (`cashTendered`) or a balance still owing means the server's null IS the answer: no Change row.
    else if (enteredTender != null && receipt.cashTendered == null && receipt.balanceDue <= 0) {
      const derived = roundMoney(enteredTender - receipt.paid);
      if (derived >= 0) {
        change = derived;
        changeAsEntered = true;
      }
    }
  }

  // The stored lines the response serves (the invoice lines): the LIST price and type each cart line was sold at. Matched in
  // two passes so a fallback can never take a line a later cart line matches exactly: (1) EVERY cart line takes the first
  // unused stored line of its product AT ITS OWN NET PRICE (two lines of one product at different prices must not swap their
  // list prices); (2) a line whose price the server did not store (a re-priced tier) takes the first unused line of the
  // product. None (an older server) means nothing is struck, never the tier price.
  const stored = receipt.lines ?? [];
  const taken = new Set<number>();
  const facts: Array<(typeof stored)[number] | undefined> = lines.map(() => undefined);
  const claim = (at: number, row: number) => {
    taken.add(at);
    facts[row] = stored[at];
  };
  lines.forEach((l, row) => {
    if (!l.productId) return;
    const at = stored.findIndex(
      (s, k) =>
        !taken.has(k) &&
        s.productId === l.productId &&
        roundMoney(s.unitPrice) === roundMoney(l.unitPrice),
    );
    if (at >= 0) claim(at, row);
  });
  lines.forEach((l, row) => {
    if (!l.productId || facts[row]) return;
    const at = stored.findIndex((s, k) => !taken.has(k) && s.productId === l.productId);
    if (at >= 0) claim(at, row);
  });
  const rows = lines.map((l, row) => {
    // ONE rule for a lowered price (pricing's receiptLineAmounts, shared with the reprint and the emailed receipt), on the
    // invoices' own original-price rule: the struck base is the stored list price.
    const sold = facts[row];
    const { total, original, discount } = receiptLineAmounts({
      unitPrice: l.unitPrice,
      originalPrice: sold?.originalPrice ?? null,
      priceType: sold?.priceType,
      hideOriginalPrice: !!profile?.hideOriginalPrice,
      qty: l.qty,
      boxes: l.boxes,
      pieces: l.pieces,
      unitsPerBox: l.unitsPerBox,
    });
    return {
      key: l.tempId,
      name: l.name,
      detail: lineDetail(l),
      note: clean(l.note) || null,
      total,
      original,
      discount,
    };
  });
  const netSubtotal = roundMoney(rows.reduce((sum, r) => sum + r.total, 0));
  const discounts = roundMoney(rows.reduce((sum, r) => sum + r.discount, 0));
  // Tax and the rate candidate are the SERVER's (the response's `tax` = Order.tax and `taxRatePercent`, from pricing's
  // storedTaxRatePercent), exactly what the reprint and the emailed receipt use. Adjustments is whatever remains. The settings
  // tax rate is not a money source here; an older server that sends no tax prints no Tax row.
  // CQ-03: the deposit / excise are their own named charges (the invoices' billed levy), never inside Tax or Adjustments.
  const { tax, charges, adjustments } = receiptFigures({
    netSubtotal,
    total: receipt.total,
    tax: receipt.tax ?? 0,
    charges: receipt.charges,
  });
  const namedRate = explainedTaxRatePercent({
    base: netSubtotal,
    tax,
    ratePercent: receipt.taxRatePercent,
  });

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
    tax,
    charges,
    adjustments,
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
    taxRatePercent: namedRate,
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
      unit?: string | null;
    } | null;
    qty: number;
    unitPrice: number;
    /** the list price the line was lowered from (`OrderItem.originalPrice`; a Decimal arrives as a string) */
    originalPrice?: number | string | null;
    /** the stored price type: the invoices' original-price rule reads it */
    priceType?: string | null;
    unitsPerBox?: number | null;
    boxes?: number | null;
    pieces?: number | null;
    /** The line note the cashier typed (OrderItem.notes). */
    notes?: string | null;
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
  /** the change due (the row's `change`, server-owned: servedChange); null/absent: no Change line prints */
  change?: number | null;
  /** the sale's single stored tax rate in percent (the row's `taxRatePercent`); null/absent: no rate known */
  taxRatePercent?: number | null;
  /** the regulated levies the invoices billed, each a named charge (the row's `charges`); absent: none */
  charges?: ReadonlyArray<{ key: string; label: string; amount: number }>;
  /** the row's customer name; null/absent for a walk-in (the row's `isWalkIn`): no customer line prints */
  customerName?: string | null;
  /** IANA zone the sale time is read in (the server's `meta.timezone`) */
  timezone?: string;
  /**
   * B1262 / SA-838, the server's split of `paid` (the row's `tenderPaid` / `tenderMethods`, `@routeflow/pricing`
   * `counterTenderSplit`): what was TENDERED, without the sale's own return credit. Used as given, never re-derived. Present:
   * Paid and the payment method read these, and `returned` prints. Absent (an older server): `paid` / `methods` as before.
   */
  tenderPaid?: number;
  tenderMethods?: ReadonlyArray<{ method: ReprintTender; amount: number }>;
  /** the row's `returned` (the amount returned and how each return was settled); read only with `tenderPaid` */
  returned?: {
    amount: number;
    returns: ReadonlyArray<{ resolution: TodaysSaleReturnResolution }>;
  } | null;
}

/** The tender of a today's-sales row (the shared POS-7b-1 type; never hand-typed here). */
export type ReprintTender = TodaysSaleMethod;

const REPRINT_METHOD_LABEL: Record<ReprintTender, string> = {
  ADVANCE: "Advance",
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
 * "Sun, Oct 11, 2:46 PM": the day label is the shared `dayCloseDateLabel` (the one the Z report title uses), read from the
 * sale's own calendar day in the sale's zone, then the time of day in that zone. Same zone fallback as `formatSaleTime`.
 */
export function formatSaleDayTime(at: string | Date, timeZone: string = "UTC"): string {
  const d = at instanceof Date ? at : new Date(at);
  const format = (zone: string) => {
    // en-CA prints a calendar date as YYYY-MM-DD, which is what dayCloseDateLabel reads.
    const day = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: zone,
    }).format(d);
    const time = new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: zone }).format(d);
    return `${dayCloseDateLabel(day)}, ${time}`;
  };
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

/**
 * The reprint's receipt model, built from the stored order. Same shape (and same line math) as `buildCounterReceipt`; the
 * differences are the facts that are never stored: Tendered and Change come from the sale row (server-owned). The date is the sale's own time, not "now".
 */
export function receiptModelFromOrder(input: {
  order: ReprintOrderLike;
  sale: ReprintSaleFacts;
  /** The sale's stored cashier (the Today's-sales row's `cashierName`); null/omitted on a sale rung before it was stamped. */
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
        unit: l.product?.unit ?? null,
      };
      // the SAME rule as the live receipt: the stored list price is struck and the difference is a Discounts row, but only
      // when the price was LOWERED (a raised or equal list price prints plain)
      const { total, original, discount } = receiptLineAmounts({
        unitPrice: line.unitPrice,
        originalPrice: l.originalPrice == null ? null : num(l.originalPrice),
        priceType: l.priceType,
        hideOriginalPrice: !!profile?.hideOriginalPrice,
        qty: line.qty,
        boxes: line.boxes,
        pieces: line.pieces,
        unitsPerBox: line.unitsPerBox,
      });
      return {
        key: line.tempId,
        name: line.name,
        detail: lineDetail(line),
        note: clean(l.notes) || null,
        total,
        original,
        discount,
      };
    });
  const netSubtotal = roundMoney(rows.reduce((sum, r) => sum + r.total, 0));
  const discounts = roundMoney(rows.reduce((sum, r) => sum + r.discount, 0));
  // B1262 / SA-838: a server that sends the tender split has already taken the sale's own return credit out of what was paid
  // and out of the methods (an unproven store credit stays a tender there), so they are read as given. An older server sends
  // neither: master's reading of `paid` / `methods`, and no Returned line.
  const split = sale.tenderPaid !== undefined;
  const tenders = split ? (sale.tenderMethods ?? sale.methods) : sale.methods;
  const hasTender = tenders.length > 0;
  const paid = split ? sale.tenderPaid! : sale.paid;
  const { balanceDue } = sale;
  const returnedAmount = split ? roundMoney(num(sale.returned?.amount)) : 0;
  const returns = sale.returned?.returns ?? [];
  const onAccount = !hasTender && balanceDue > 0;
  const orderTotal = num(order.total);
  const { tax, charges, adjustments } = receiptFigures({
    netSubtotal,
    total: orderTotal,
    tax: num(order.tax),
    charges: sale.charges,
  });
  // Name the rate only when it accounts for the stored tax (a re-price or credit must not read as tax); else plain "Tax".
  const taxRatePercent = explainedTaxRatePercent({
    base: netSubtotal,
    tax,
    ratePercent: sale.taxRatePercent,
  });
  const tendered = sale.cashTendered ?? null;
  return {
    header: receiptHeader(profile),
    orderNumber: order.orderNumber,
    invoiceNumber: sale.invoiceNumber,
    invoiceId: sale.invoiceId,
    dateLabel: formatSaleTime(sale.createdAt, sale.timezone),
    lines: rows,
    cashier: clean(input.cashier) || null,
    subtotal: roundMoney(netSubtotal + discounts),
    tax,
    charges,
    adjustments,
    discounts,
    total: orderTotal,
    paid,
    balanceDue,
    onAccount,
    paymentNotRecorded: false,
    showPaid: hasTender,
    showBalance: onAccount || balanceDue > 0,
    methodLabel: hasTender ? tenders.map((m) => REPRINT_METHOD_LABEL[m.method]).join(" + ") : null,
    ...(split
      ? {
          returned: returnedAmount > 0 ? returnedAmount : null,
          // "Refunded" only when every return went out as a refund; a store-credit or still-pending one reads "Returned"
          returnedLabel: (returns.length > 0 && returns.every((r) => r.resolution === "REFUND")
            ? "Refunded"
            : "Returned") as "Returned" | "Refunded",
        }
      : {}),
    tendered,
    tenderedAsEntered: false,
    // the server's figure (the row's `change`, servedChange), shown as given: the client recomputes nothing
    change: tendered == null ? null : (sale.change ?? null),
    changeAsEntered: false,
    taxRatePercent,
    customerName: clean(sale.customerName) || null,
    footer: receiptFooterOf(profile),
  };
}
