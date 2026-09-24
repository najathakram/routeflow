import { inferredFlatRate } from "@routeflow/pricing";

/**
 * B294 (SA-141): each stored line's `{ taxRate, taxable }` when the operator invoice edit loads.
 *
 * A legacy order- or estimate-derived invoice stores `taxRate: 0` on every line while its header
 * carries the real tax. Hydrating `taxable: taxRate > 0` loaded those lines as NON-taxable, so
 * the save sent `taxRate: 0` and silently dropped the sales tax. When the SHARED rule
 * (@routeflow/pricing inferredFlatRate, the same one applyPriceAdjustment and the backfill use)
 * verifies a flat rate, each 0-rate line loads at that rate and as taxable. A line with its own
 * rate always keeps it.
 */
export function hydratedLineTax(invoice: {
  subtotal?: unknown;
  taxAmount?: unknown;
  items?: ReadonlyArray<{ taxRate?: unknown; categoryTaxAmount?: unknown }>;
}): Array<{ taxRate: number; taxable: boolean }> {
  const items = invoice.items ?? [];
  const inferred = inferredFlatRate({
    subtotal: invoice.subtotal,
    taxAmount: invoice.taxAmount,
    lines: items,
  });
  const fill = inferred?.verified ? inferred.rate : 0;
  return items.map((it) => {
    const stored = Number(it.taxRate ?? 0);
    const taxRate = stored > 0 ? stored : fill;
    return { taxRate, taxable: taxRate > 0 };
  });
}
