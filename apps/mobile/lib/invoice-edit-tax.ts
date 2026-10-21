import { inferredGoodsFlatRate, isNsfLine } from "@routeflow/pricing";

/**
 * B294 (SA-141): each stored line's `{ taxRate, taxable }` when the operator invoice edit loads.
 *
 * A legacy order- or estimate-derived invoice stores `taxRate: 0` on every line while its header
 * carries the real tax. Hydrating `taxable: taxRate > 0` loaded those lines as NON-taxable, so
 * the save sent `taxRate: 0` and silently dropped the sales tax. When the SHARED rule
 * (@routeflow/pricing inferredGoodsFlatRate, the same one applyPriceAdjustment and the backfill use)
 * verifies a flat rate, each 0-rate line loads at that rate and as taxable. A line with its own
 * rate always keeps it.
 */
export function hydratedLineTax(
  invoice: {
    subtotal?: unknown;
    taxAmount?: unknown;
    items?: ReadonlyArray<{
      taxRate?: unknown;
      categoryTaxAmount?: unknown;
      subtotal?: unknown;
      systemKind?: string | null;
      description?: string | null;
    }>;
  },
  /** The tenant's configured rate (a fraction): it wins the inference when it reproduces the stored tax. */
  tenantRate?: number,
): Array<{ taxRate: number; taxable: boolean }> {
  const items = invoice.items ?? [];
  // #2392 / SA-478: the NSF bounce-fee line is never taxed. #2656: the goods-only inference (line
  // AND money excluded, subtotal rounded) is the ONE shared helper, and an NSF line is never filled.
  const nsf = items.map((it) => isNsfLine(it));
  const inferred = inferredGoodsFlatRate(
    { subtotal: invoice.subtotal, taxAmount: invoice.taxAmount, lines: items },
    { preferredRate: tenantRate },
  );
  const fill = inferred?.verified ? inferred.rate : 0;
  return items.map((it, i) => {
    const stored = Number(it.taxRate ?? 0);
    // #2656 / SA-549: the NSF line is NEVER taxed, even when a legacy row stored a rate — the API
    // refuses > 0 on it, so it loads (and saves) at 0.
    const taxRate = nsf[i] ? 0 : stored > 0 ? stored : fill;
    return { taxRate, taxable: taxRate > 0 };
  });
}
