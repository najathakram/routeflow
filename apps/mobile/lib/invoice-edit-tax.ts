import { inferredFlatRate, isNsfLine } from "@routeflow/pricing";

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
  items?: ReadonlyArray<{
    taxRate?: unknown;
    categoryTaxAmount?: unknown;
    subtotal?: unknown;
    systemKind?: string | null;
    description?: string | null;
  }>;
}): Array<{ taxRate: number; taxable: boolean }> {
  const items = invoice.items ?? [];
  // #2392 / SA-478: the NSF bounce-fee line is never taxed. It is excluded from the inference —
  // both its line and its money, since the header subtotal includes the untaxed fee (otherwise the
  // rate is diluted: $7.50 on $100 goods + a $25 fee read as 0.06) — and it is never filled.
  const nsf = items.map((it) => isNsfLine(it));
  const nsfSubtotal = items.reduce((s, it, i) => (nsf[i] ? s + (Number(it.subtotal) || 0) : s), 0);
  const inferred = inferredFlatRate({
    subtotal: (Number(invoice.subtotal) || 0) - nsfSubtotal,
    taxAmount: invoice.taxAmount,
    lines: items.filter((_, i) => !nsf[i]),
  });
  const fill = inferred?.verified ? inferred.rate : 0;
  return items.map((it, i) => {
    const stored = Number(it.taxRate ?? 0);
    const taxRate = stored > 0 ? stored : nsf[i] ? 0 : fill;
    return { taxRate, taxable: taxRate > 0 };
  });
}
