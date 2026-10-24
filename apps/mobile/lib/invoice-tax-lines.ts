import { invoiceTaxSplit, type ChargeLine } from "@routeflow/pricing";

/** An invoice line as the tax split reads it (all optional: an older payload simply has no levy). */
export interface TaxSplitItem {
  categoryTaxAmount?: unknown;
  trackedCategoryId?: string | null;
  /** the tax type frozen on the line at sale time (B297) */
  categoryTaxType?: string | null;
  /** the category row (`GET /invoices/:id` includes it) */
  trackedCategory?: { id?: string | null; name?: string | null; taxType?: string | null } | null;
}

/**
 * Row 398: the invoice header `taxAmount` holds the regular tax PLUS the regulated levy (deposit, excise). The detail
 * screen shows them apart, as the PDF and the web page do: Tax is the regular tax and each regulated category is its own
 * named charge ("CRV deposit"). The one formula is `invoiceTaxSplit` in @routeflow/pricing; this only adapts the payload.
 */
export function invoiceTaxLines(invoice: {
  taxAmount?: unknown;
  items?: readonly TaxSplitItem[] | null;
}): { tax: number; charges: ChargeLine[] } {
  return invoiceTaxSplit(invoice.taxAmount, invoice.items ?? []);
}
