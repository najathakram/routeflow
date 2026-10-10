import type { SellLevel } from "@routeflow/pricing";

/**
 * units_v1 (SA-085h LOW) + SA-580b: the "Add 1 <label>?" confirm applies only to today's piece case,
 * a UNIT scan on a BOXED product whose line is sold by a unit label. A shared code that resolves to
 * the default UNIT on an upb<=1 product is today's plain +1 line - no prompt.
 */
export function needsUnitLabelConfirm(
  level: SellLevel,
  product: { unitsPerBox?: number | null },
  label: string | null | undefined,
): boolean {
  return level === "UNIT" && Number(product.unitsPerBox ?? 0) > 1 && !!label;
}
