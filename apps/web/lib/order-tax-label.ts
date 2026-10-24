import { explainedTaxRatePercent, storedTaxRatePercent, taxRowLabel } from "@routeflow/pricing";

/**
 * Row 329a: the Tax row's label on the order edit panel. It never invents a rate: the old label printed the order's own
 * tax / subtotal ratio rounded to a whole percent ("Tax (8%)" for 8.25%). The rate is named only the way every receipt names
 * it: a STORED invoice line rate (the one distinct non-zero rate on the order's live invoices, `storedTaxRatePercent`)
 * corroborated by the tenant's configured rate, and only when it reproduces the order's tax to the cent
 * (`explainedTaxRatePercent`). Anything else (no invoice yet, mixed rates, a rate the tenant never configured, a re-priced
 * tax) is plain "Tax". The percent printed is the exact configured one (8.25, never 8).
 */
const DEAD_INVOICE_STATUSES = ["VOID", "WRITTEN_OFF"];

export function orderTaxLabel(
  order: { subtotal: number | string; tax: number | string },
  invoices:
    | ReadonlyArray<{ status: string; items?: ReadonlyArray<{ taxRate?: unknown }> }>
    | null
    | undefined,
  configuredPercent: number | null | undefined,
): string {
  const live = (invoices ?? []).filter((i) => !DEAD_INVOICE_STATUSES.includes(i.status));
  const candidate = storedTaxRatePercent(
    live.map((i) => ({ lines: i.items ?? [] })),
    configuredPercent,
  );
  return taxRowLabel(
    explainedTaxRatePercent({
      base: Number(order.subtotal),
      tax: Number(order.tax),
      ratePercent: candidate,
    }),
  );
}
