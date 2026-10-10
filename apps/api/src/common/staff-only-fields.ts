/**
 * Customer-facing order and invoice responses carry an ALLOWLIST of fields, never "everything but".
 *
 * A DENYLIST of staff-only keys leaks every column added to Order / OrderItem / Invoice /
 * InvoicePayment tomorrow (an idempotency key, a write-off reason, a payment's image key, a bounce
 * reason ...). Here a customer-facing response is a PROJECTION: only the keys listed below survive,
 * at every level, so a new column stays staff-only until someone lists it. The lists are built from
 * the fields the buyer screens read (apps/web/app/buyer/**, apps/mobile/app/(customer)/**) and the
 * shared buyer contract (packages/types/api/buyer.ts). The sibling of `pickSelfServiceFields`
 * (customers/self-service-fields.ts), which does the same for what a customer may WRITE.
 *
 * Applied at every CUSTOMER / buyer-portal read and write route, alongside `redactUpsellForCustomer`
 * (./upsell-redaction.ts, which must run FIRST: it nulls an upsell's base price in place). Every
 * helper returns a COPY and never mutates its input, so a staff caller holding the same row is
 * unaffected; staff responses never go through here. null / undefined pass through as-is, and a
 * non-object value passes through unchanged. Money fields derived from rows this helper trims
 * (balanceDue, paidAmount ...) must be computed BEFORE it runs.
 */
import { redactUpsellForCustomer } from "./upsell-redaction";
import { derivedBackordered, type BackorderVisibility } from "../orders/backorder-visibility";

/** Order scalars + relations a buyer screen reads. `customer`, `routeRun`, `editWindow` are projected below. */
export const CUSTOMER_ORDER_FIELDS = [
  "id",
  "orderNumber",
  "status",
  "createdAt",
  "requestedDeliveryDate",
  "deliveredAt",
  "notes",
  "urgent",
  "subtotal",
  "tax",
  "total",
  "discountAmount",
  "editWindow",
  // How the order reaches the buyer and, once shipped, its carrier details (the shipment card).
  "fulfillPath",
  "shippingCarrier",
  "shippingTrackingNumber",
  "shippedAt",
] as const;

/** Order line (OrderItem) scalars a buyer screen reads. `product` and `components` are projected below. */
export const CUSTOMER_ORDER_ITEM_FIELDS = [
  "id",
  "productId",
  "name",
  "qty",
  "deliveredQty",
  "unitPrice",
  "subtotal",
  "priceType",
  "originalPrice",
  "status",
  "boxes",
  "pieces",
  "unitsPerBox",
  "unitLabel",
  "promoFreeUnits",
  "categoryTaxAmount",
  "notes",
] as const;

/** Invoice scalars + the money fields the server derives for the buyer. `items` / `payments` are projected below. */
export const CUSTOMER_INVOICE_FIELDS = [
  "id",
  "invoiceNumber",
  "status",
  "issueDate",
  "dueDate",
  "createdAt",
  "sentAt",
  "paidAt",
  "orderId",
  "subtotal",
  "taxAmount",
  "discount",
  "shippingFee",
  "total",
  "notes",
  "terms",
  "pdfUrl",
  "paymentTermsLabel",
  "depositPercent",
  "depositDueDate",
  "depositAmount",
  "depositOverdue",
  "hideOriginalPrice",
  "balanceDue",
  "paidAmount",
  "creditApplied",
  "advanceApplied",
  "isOverdue",
] as const;

/** Invoice line scalars a buyer screen reads. `product` and `components` are projected below; the
 *  line's tracked category / subcategory are not (no buyer screen renders them). */
export const CUSTOMER_INVOICE_ITEM_FIELDS = [
  "id",
  "description",
  "productId",
  "qty",
  "unitPrice",
  "discount",
  "originalPrice",
  "msrp",
  "priceType",
  "subtotal",
  "unitLabel",
  "boxes",
  "pieces",
  "unitsPerBox",
  "promoFreeUnits",
  "notes",
  "categoryTaxAmount",
] as const;

/** Invoice payment scalars a buyer screen reads (no memo, image key, bank charge, bounce reason or replaced-payment link). */
export const CUSTOMER_PAYMENT_FIELDS = [
  "id",
  "invoiceId",
  "amount",
  "method",
  "reference",
  "paidAt",
  "createdAt",
  "status",
  "checkStatus",
  "nsfFeeAmount",
] as const;

/** The invoice stub an order's detail carries. */
const CUSTOMER_ORDER_INVOICE_FIELDS = ["id", "invoiceNumber", "status", "total"] as const;
const CUSTOMER_PRODUCT_FIELDS = ["id", "name", "unit", "unitsPerBox"] as const;
const CUSTOMER_COMPONENT_FIELDS = [
  "id",
  "componentProductId",
  "name",
  "qty",
  "unitSku",
  "unitBarcode",
  "barcodeSymbology",
  "displayUnitPrice4",
  "position",
] as const;
const CUSTOMER_CREDIT_NOTE_FIELDS = [
  "id",
  "creditNoteNumber",
  "reason",
  "amount",
  "amountUsed",
  "status",
] as const;
const CUSTOMER_CHANGE_REQUEST_FIELDS = [
  "id",
  "orderId",
  "orderItemId",
  "productId",
  "type",
  "status",
  "payload",
  "note",
  "resolution",
  "resolutionReason",
  "nextOrderId",
  "resolvedAt",
  "createdAt",
] as const;

/** A payment row is confirmed only when PAID (the same rule as `splitConfirmed`). */
const CONFIRMED_PAYMENT_STATUS = "PAID";
const DRAFT_INVOICE_STATUS = "DRAFT";

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The listed keys of `row` that are present, copied (a Decimal / Date value is carried by reference). */
function pick(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(row, key)) out[key] = row[key];
  return out;
}

/** `value` projected through `fn` when it is a row, mapped when it is an array, as-is otherwise (null stays null). */
function shape(value: unknown, fn: (row: Row) => Row): unknown {
  if (Array.isArray(value)) return value.map((v) => (isRow(v) ? fn(v) : v));
  return isRow(value) ? fn(value) : value;
}

const customerProduct = (p: Row) => pick(p, CUSTOMER_PRODUCT_FIELDS);
const customerComponent = (c: Row) => pick(c, CUSTOMER_COMPONENT_FIELDS);

/** What the order projection may derive from the seller's settings (never from a client). */
export interface CustomerOrderOptions {
  /**
   * OOS PR2: the seller's `orders.buyerBackorderVisibility`. Only "show" adds the derived
   * `backordered` flag to a line (and only when the line carries the persisted marker); "hide" and
   * an absent option add NOTHING, and the raw marker column is in no allowlist.
   */
  backorderVisibility?: BackorderVisibility;
}

function customerOrderItem(line: Row, opts: CustomerOrderOptions = {}): Row {
  const out = pick(line, CUSTOMER_ORDER_ITEM_FIELDS);
  const backordered = derivedBackordered(opts.backorderVisibility ?? "hide", line);
  if (backordered !== undefined) out.backordered = backordered;
  if ("product" in line) out.product = shape(line.product, customerProduct);
  if ("components" in line) out.components = shape(line.components, customerComponent);
  return out;
}

function customerInvoiceItem(line: Row): Row {
  const out = pick(line, CUSTOMER_INVOICE_ITEM_FIELDS);
  if ("product" in line) out.product = shape(line.product, customerProduct);
  if ("components" in line) out.components = shape(line.components, customerComponent);
  return out;
}

function customerPayment(payment: Row): Row {
  const out = pick(payment, CUSTOMER_PAYMENT_FIELDS);
  if ("creditNote" in payment) {
    out.creditNote = shape(payment.creditNote, (c) => pick(c, CUSTOMER_CREDIT_NOTE_FIELDS));
  }
  return out;
}

/**
 * A customer-facing copy of an invoice: the allowlisted scalars, its lines and its payments, each
 * projected the same way. `confirmedPaymentsOnly` also keeps only PAID payment rows (the customer's
 * invoice LIST shows money received, never an unconfirmed or VOID row).
 */
export function pickCustomerInvoiceFields<T>(
  invoice: T,
  opts: { confirmedPaymentsOnly?: boolean } = {},
): T {
  if (!isRow(invoice)) return invoice;
  const out = pick(invoice, CUSTOMER_INVOICE_FIELDS);
  if ("customer" in invoice) {
    out.customer = shape(invoice.customer, (c) => pick(c, ["id", "businessName"]));
  }
  if ("items" in invoice) out.items = shape(invoice.items, customerInvoiceItem);
  if ("payments" in invoice) {
    const payments =
      opts.confirmedPaymentsOnly && Array.isArray(invoice.payments)
        ? invoice.payments.filter((p) => isRow(p) && p.status === CONFIRMED_PAYMENT_STATUS)
        : invoice.payments;
    out.payments = shape(payments, customerPayment);
  }
  return out as T;
}

/**
 * A page of invoices for a caller: a CUSTOMER gets the allowlist of each, with confirmed (PAID)
 * payment rows only (the money is derived from the payments BEFORE this runs); staff get `rows`
 * itself.
 */
export function customerInvoiceList<T>(rows: T[], isCustomer: boolean): T[] {
  return isCustomer
    ? rows.map((inv) => pickCustomerInvoiceFields(inv, { confirmedPaymentsOnly: true }))
    : rows;
}

/**
 * What a CUSTOMER / buyer response carries for an order, in the one right order: an upsell line's
 * base price is redacted first (in place, on the freshly read row — `redactUpsellForCustomer`),
 * then the allowlist projects a copy. Use this at every customer-reachable order route.
 */
export function toCustomerOrder<T>(order: T, opts: CustomerOrderOptions = {}): T {
  return pickCustomerOrderFields(redactUpsellForCustomer(order), opts);
}

const CUSTOMER_ROLE = "CUSTOMER";
type Caller = { role?: string } | null | undefined;

/** `toCustomerOrder` for a CUSTOMER caller; anyone else gets the order as read. */
export function orderFor<T>(user: Caller, order: T, opts: CustomerOrderOptions = {}): T {
  return user?.role === CUSTOMER_ROLE ? toCustomerOrder(order, opts) : order;
}

/** `orderFor` over a page of orders. */
export function ordersFor<T>(user: Caller, rows: T[], opts: CustomerOrderOptions = {}): T[] {
  return user?.role === CUSTOMER_ROLE ? rows.map((r) => toCustomerOrder(r, opts)) : rows;
}

/**
 * The invoice detail for a CUSTOMER caller (the allowlist, DRAFT invoices already 404ed by the caller:
 * a DRAFT is the seller's unissued working copy); anyone else gets the detail as read.
 */
export function invoiceDetailFor<T>(user: Caller, detail: T): T {
  return user?.role === CUSTOMER_ROLE ? pickCustomerInvoiceFields(detail) : detail;
}

/**
 * A customer-facing copy of an order: the allowlisted scalars, its lines, its change requests, its
 * run's status and its invoice stubs. The order's own invoice list (when present) loses its DRAFT
 * invoices (the seller's unissued working copies).
 */
export function pickCustomerOrderFields<T>(order: T, opts: CustomerOrderOptions = {}): T {
  if (!isRow(order)) return order;
  const out = pick(order, CUSTOMER_ORDER_FIELDS);
  if ("customer" in order) {
    out.customer = shape(order.customer, (c) => pick(c, ["id", "businessName"]));
  }
  if ("lineItems" in order) {
    out.lineItems = shape(order.lineItems, (line) => customerOrderItem(line, opts));
  }
  if ("changeRequests" in order) {
    out.changeRequests = shape(order.changeRequests, (c) =>
      pick(c, CUSTOMER_CHANGE_REQUEST_FIELDS),
    );
  }
  if ("_count" in order) {
    // The orders-list "pending change requests" badge count (a number, never a row).
    out._count = shape(order._count, (c) => pick(c, ["changeRequests"]));
  }
  if ("routeRun" in order) {
    out.routeRun = shape(order.routeRun, (r) => pick(r, ["status", "startedAt"]));
  }
  if ("invoices" in order && Array.isArray(order.invoices)) {
    out.invoices = order.invoices
      .filter((inv) => !(isRow(inv) && inv.status === DRAFT_INVOICE_STATUS))
      .map((inv) => (isRow(inv) ? pick(inv, CUSTOMER_ORDER_INVOICE_FIELDS) : inv));
  }
  return out as T;
}
