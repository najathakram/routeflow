import { InvoiceStatus } from "@prisma/client";
import {
  computeLineSubtotal,
  explainedTaxRatePercent,
  roundMoney,
  storedTaxRatePercent,
  sumConfirmed,
} from "@routeflow/pricing";
import type { ReceiptLine, ReceiptModel } from "@routeflow/types";
import { servedChange } from "../orders/counter-sale/counter-sale-readback";
import { RECEIPT_FOOTER_MAX_CHARS } from "../system-config/receipt-footer";
import { todaysMethodOf } from "../orders/counter-sale/counter-sale-today";

/**
 * The pure half of the order receipt (SA-751r): stored rows in, the shared `ReceiptModel` out. It mirrors the web's
 * `receiptModelFromOrder` (the print view's reprint), line for line, so the email and the print can never print different
 * figures for the same sale. Money goes through @routeflow/pricing; nothing here reads a clock, a database or a request.
 *
 * ONE money model (SA-762r): Tax is the order's tax, Adjustments whatever remains after it, and the tax rate is named only
 * when `explainedTaxRatePercent` says the stored line rate reproduces the tax. The same helper names the rate on the counter
 * receipt and the reprint; nothing here derives it differently.
 */

/** An order line as the receipt select returns it (Decimals arrive as strings or Decimal objects: always `Number()`ed). */
export interface ReceiptLineInput {
  id: string;
  name: string | null;
  status: string;
  qty: unknown;
  unitPrice: unknown;
  unitsPerBox: number | null;
  boxes: number | null;
  pieces: number | null;
  product: {
    name: string;
    variantName: string | null;
    parentProductId: string | null;
    parent: { name: string } | null;
  } | null;
}

export interface ReceiptOrderInput {
  id: string;
  orderNumber: string | null;
  status: string;
  total: unknown;
  tax: unknown;
  createdAt: Date;
  orderDate: Date | null;
  counterSale: boolean;
  /** cash handed over (`Order.counterCashTendered`); null on a legacy or non-cash sale: no Tendered / Change */
  counterCashTendered?: unknown;
  /** only the name and the walk-in flag: the customer's email is never read (the address is the cashier's to type) */
  customer: { businessName: string | null; isWalkIn: boolean | null } | null;
  lineItems: ReceiptLineInput[];
}

export interface ReceiptInvoiceInput {
  id: string;
  invoiceNumber: string | null;
  status: string;
  /** the stored line rates the tax rate is read from; absent = no rate can be named */
  items?: ReadonlyArray<{ taxRate?: unknown }>;
}

export interface ReceiptPaymentInput {
  invoiceId: string;
  method: string;
  amount: unknown;
  status: string;
}

/** The receipt header and footer: TenantConfig first, the legacy SystemConfig values behind it (as `GET /settings` reads them). */
export interface ReceiptBranding {
  businessName?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  /** SystemConfig `receiptFooter`: tenant text, at most 200 characters. HTML-escaped by the email template. */
  footer?: string | null;
  /** the tenant's configured rate in percent (`settings.taxRate`): a stored line rate is named only when it equals this */
  configuredTaxPercent?: number | null;
}

const DEAD_INVOICE_STATUSES: readonly string[] = [InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF];

/** A live invoice: not VOID and not written off (the same rule Today's sales uses for "voided"). */
export const isLiveInvoice = (i: Pick<ReceiptInvoiceInput, "status">): boolean =>
  !DEAD_INVOICE_STATUSES.includes(i.status);

const METHOD_ORDER = ["CASH", "CARD", "CHECK", "OTHER", "STORE_CREDIT"] as const;
const METHOD_LABEL: Record<(typeof METHOD_ORDER)[number], string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  OTHER: "Other",
  STORE_CREDIT: "Store credit",
};

/** Sign first: a downward reprice reads "-$1.00", never "$-1.00". Same text as the web's `formatReceiptMoney`. */
export const formatReceiptMoney = (n: number): string =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

const clean = (s: string | null | undefined): string => (s ?? "").trim();
const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** "Oct 7, 2026, 11:15 AM" in the given zone; a zone Intl does not know falls back to UTC (never a RangeError). */
export function formatSaleTime(at: Date, timeZone?: string | null): string {
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: zone,
    }).format(at);
  try {
    return format(timeZone || undefined);
  } catch {
    return format("UTC");
  }
}

/** A catalogue product's display name, the web's `displayProductName` rule: a variant reads "<parent> - <variant>". */
function productName(p: NonNullable<ReceiptLineInput["product"]>): string {
  if (!p.parentProductId && !p.parent) return p.name;
  const variant = (p.variantName ?? p.name).trim();
  if (!variant) return p.name;
  const parent = p.parent?.name;
  if (!parent) return variant;
  // a legacy variant name that already starts with the parent's must not double up
  return variant.toLowerCase().startsWith(`${parent} - `.toLowerCase())
    ? variant
    : `${parent} - ${variant}`;
}

function lineName(l: ReceiptLineInput): string {
  const base = clean(l.product ? productName(l.product) : l.name) || clean(l.name);
  return base || "Item";
}

/** "3 × $2.50" or "1 box + 3 pcs × $12.00 per box" */
function lineDetail(l: ReceiptLineInput): string {
  const price = formatReceiptMoney(num(l.unitPrice));
  if ((l.unitsPerBox ?? 0) <= 1) return `${num(l.qty)} × ${price}`;
  const boxes = l.boxes ?? 0;
  const pieces = l.pieces ?? 0;
  const parts = [`${boxes} box${boxes === 1 ? "" : "es"}`];
  if (pieces) parts.push(`${pieces} pcs`);
  return `${parts.join(" + ")} × ${price} per box`;
}

function receiptHeader(b: ReceiptBranding) {
  const cityLine = [[clean(b.city), clean(b.state)].filter(Boolean).join(", "), clean(b.zip)]
    .filter(Boolean)
    .join(" ");
  return {
    name: clean(b.businessName) || null,
    addressLines: [clean(b.street), cityLine].filter(Boolean),
    phone: clean(b.phone) || null,
  };
}

export function buildReceiptModel(
  order: ReceiptOrderInput,
  invoices: readonly ReceiptInvoiceInput[],
  payments: readonly ReceiptPaymentInput[],
  branding: ReceiptBranding,
  zone: string | null,
): ReceiptModel {
  const live = invoices.filter(isLiveInvoice);
  const shown = live[0] ?? invoices[0];
  const liveIds = new Set(live.map((i) => i.id));
  const livePayments = payments.filter((p) => liveIds.has(p.invoiceId));

  const lines: ReceiptLine[] = order.lineItems
    .filter((l) => l.status !== "CANCELLED")
    .map((l) => ({
      key: l.id,
      name: lineName(l),
      detail: lineDetail(l),
      // a reprint shows no per-line note and no discount (the order does not store the system price an edit started from)
      note: null,
      original: null,
      discount: 0,
      total: computeLineSubtotal({
        unitPrice: num(l.unitPrice),
        qty: num(l.qty),
        boxes: l.boxes,
        pieces: l.pieces,
        unitsPerBox: l.unitsPerBox,
      }),
    }));
  const subtotal = roundMoney(lines.reduce((sum, l) => sum + l.total, 0));
  const total = roundMoney(num(order.total));
  const paid = roundMoney(
    sumConfirmed(livePayments.map((p) => ({ amount: p.amount, status: p.status }))),
  );
  const balanceDue = Math.max(0, roundMoney(total - paid));

  const appliedBy = (method: (typeof METHOD_ORDER)[number]) =>
    roundMoney(
      sumConfirmed(
        livePayments
          .filter((p) => todaysMethodOf(p.method) === method)
          .map((p) => ({ amount: p.amount, status: p.status })),
      ),
    );
  const methods = METHOD_ORDER.filter((method) => appliedBy(method) > 0);
  const hasTender = methods.length > 0;
  const onAccount = !hasTender && balanceDue > 0;
  const tax = roundMoney(num(order.tax));
  const adjustments = roundMoney(total - subtotal - tax) || 0; // never -0
  const taxRatePercent = explainedTaxRatePercent({
    base: subtotal,
    tax,
    // a STORED line rate corroborated by the configured rate; never inferred from the tax (pricing)
    ratePercent: storedTaxRatePercent(
      live.map((i) => ({ lines: i.items ?? [] })),
      branding.configuredTaxPercent,
    ),
  });
  // Tendered is what was handed over; Change is the SERVER's figure, from the one gate the POST / by-key response and the
  // Today's row use (`servedChange`: a CASH-first sale with nothing left to pay), never recomputed here. The payments arrive
  // in the order they were taken (the service orders them), because the first stored tender decides.
  const tendered =
    order.counterCashTendered == null ? null : roundMoney(num(order.counterCashTendered));
  // cut by code points (never through a surrogate pair) at the ONE footer cap the settings route enforces
  const footer = Array.from(clean(branding.footer)).slice(0, RECEIPT_FOOTER_MAX_CHARS).join("");
  const walkIn = !order.customer || !!order.customer.isWalkIn;
  const customerName = walkIn ? "" : clean(order.customer?.businessName);
  // a counter sale is dated when it was rung; any other order by its business date
  const soldAt = order.counterSale ? order.createdAt : (order.orderDate ?? order.createdAt);

  return {
    header: receiptHeader(branding),
    orderNumber: order.orderNumber ?? "",
    invoiceNumber: shown?.invoiceNumber ?? "",
    invoiceId: shown?.id ?? "",
    dateLabel: formatSaleTime(soldAt, zone),
    lines,
    cashier: null,
    customerName: customerName || null,
    subtotal,
    discounts: 0,
    tax,
    adjustments,
    taxRatePercent,
    footer: footer || null,
    total,
    paid,
    balanceDue,
    onAccount,
    paymentNotRecorded: false,
    showPaid: hasTender,
    showBalance: onAccount || balanceDue > 0,
    methodLabel: hasTender ? methods.map((m) => METHOD_LABEL[m]).join(" + ") : null,
    tendered,
    tenderedAsEntered: false,
    change: servedChange(order.counterCashTendered, livePayments, balanceDue),
    changeAsEntered: false,
  };
}
