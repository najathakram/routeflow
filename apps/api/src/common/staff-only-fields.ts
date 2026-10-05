/**
 * Customer-facing order and invoice responses carry customer-facing fields only.
 *
 * The staff-internal fields below are written by operators for operators and never reach a
 * CUSTOMER or buyer-portal response. The sibling of `omitStaffOnlyCustomerFields`
 * (customers/self-service-fields.ts) for orders and invoices, applied at every customer/buyer read
 * route alongside `redactUpsellForCustomer` (./upsell-redaction.ts). Unlike that helper these
 * return a COPY and never mutate the input, so a staff caller holding the same row is unaffected.
 * Shapes without a listed key pass through unchanged; null/undefined pass through as-is.
 */

/** Order line / invoice line: who overrode the price, and why. */
export const STAFF_ONLY_LINE_FIELDS = ["overrideReason", "overriddenBy"] as const;
/** Order: the sales-agent commission rate. */
export const STAFF_ONLY_ORDER_FIELDS = ["commissionRatePct"] as const;
/** Invoice: the operator's internal memo (the printed `notes` stay). */
export const STAFF_ONLY_INVOICE_FIELDS = ["internalNotes"] as const;
/** Invoice payment: the operator's payment memo. */
export const STAFF_ONLY_PAYMENT_FIELDS = ["notes"] as const;

/** A payment row is confirmed only when PAID (the same rule as `splitConfirmed`). */
const CONFIRMED_PAYMENT_STATUS = "PAID";
const DRAFT_INVOICE_STATUS = "DRAFT";

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function without(row: Row, keys: readonly string[]): Row {
  const out: Row = { ...row };
  for (const key of keys) delete out[key];
  return out;
}

function mapRows(value: unknown, fn: (row: Row) => Row): unknown {
  return Array.isArray(value) ? value.map((v) => (isRow(v) ? fn(v) : v)) : value;
}

const omitLine = (line: Row) => without(line, STAFF_ONLY_LINE_FIELDS);

/**
 * A copy of an invoice without the staff-only fields: internal notes, each line's override
 * reason/author, each payment's notes. `confirmedPaymentsOnly` also keeps only PAID payment rows
 * (the customer's invoice LIST shows money received, never an unconfirmed or VOID row). Money
 * fields derived from the payments must be computed BEFORE this runs.
 */
export function omitStaffOnlyInvoiceFields<T>(
  invoice: T,
  opts: { confirmedPaymentsOnly?: boolean } = {},
): T {
  if (!isRow(invoice)) return invoice;
  const out = without(invoice, STAFF_ONLY_INVOICE_FIELDS);
  if ("items" in out) out.items = mapRows(out.items, omitLine);
  if ("payments" in out) {
    const payments =
      opts.confirmedPaymentsOnly && Array.isArray(out.payments)
        ? out.payments.filter((p) => isRow(p) && p.status === CONFIRMED_PAYMENT_STATUS)
        : out.payments;
    out.payments = mapRows(payments, (p) => without(p, STAFF_ONLY_PAYMENT_FIELDS));
  }
  return out as T;
}

/**
 * A copy of an order without the staff-only fields: the commission rate and each line's override
 * reason/author. The order's own invoice list (when present) loses its DRAFT invoices (the
 * seller's unissued working copies) and each remaining invoice goes through
 * `omitStaffOnlyInvoiceFields`.
 */
export function omitStaffOnlyOrderFields<T>(order: T): T {
  if (!isRow(order)) return order;
  const out = without(order, STAFF_ONLY_ORDER_FIELDS);
  if ("lineItems" in out) out.lineItems = mapRows(out.lineItems, omitLine);
  if ("invoices" in out && Array.isArray(out.invoices)) {
    out.invoices = out.invoices
      .filter((inv) => !(isRow(inv) && inv.status === DRAFT_INVOICE_STATUS))
      .map((inv) => omitStaffOnlyInvoiceFields(inv));
  }
  return out as T;
}
