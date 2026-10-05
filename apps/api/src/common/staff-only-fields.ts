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

/** Invoice line scalars a buyer screen reads. `product`, `trackedCategory`, `components` are projected below. */
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

function customerOrderItem(line: Row): Row {
  const out = pick(line, CUSTOMER_ORDER_ITEM_FIELDS);
  if ("product" in line) out.product = shape(line.product, customerProduct);
  if ("components" in line) out.components = shape(line.components, customerComponent);
  return out;
}

function customerInvoiceItem(line: Row): Row {
  const out = pick(line, CUSTOMER_INVOICE_ITEM_FIELDS);
  if ("product" in line) out.product = shape(line.product, customerProduct);
  if ("components" in line) out.components = shape(line.components, customerComponent);
  for (const key of ["trackedCategory", "trackedSubcategory"] as const) {
    if (key in line) {
      out[key] = shape(line[key], (c) => pick(c, ["id", "name", "invoiceTreatment"]));
    }
  }
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
 * What a CUSTOMER / buyer response carries for an order, in the one right order: an upsell line's
 * base price is redacted first (in place, on the freshly read row — `redactUpsellForCustomer`),
 * then the allowlist projects a copy. Use this at every customer-reachable order route.
 */
export function toCustomerOrder<T>(order: T): T {
  return pickCustomerOrderFields(redactUpsellForCustomer(order));
}

/**
 * A customer-facing copy of an order: the allowlisted scalars, its lines, its change requests, its
 * run's status and its invoice stubs. The order's own invoice list (when present) loses its DRAFT
 * invoices (the seller's unissued working copies).
 */
export function pickCustomerOrderFields<T>(order: T): T {
  if (!isRow(order)) return order;
  const out = pick(order, CUSTOMER_ORDER_FIELDS);
  if ("customer" in order) {
    out.customer = shape(order.customer, (c) => pick(c, ["id", "businessName"]));
  }
  if ("lineItems" in order) out.lineItems = shape(order.lineItems, customerOrderItem);
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
