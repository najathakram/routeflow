/**
 * Configured tenant label for a pricing tier, hard-falling back to "Tier N".
 *
 * Tiers are the existing pricePerUnit/priceTier2..5 MECHANISM (untouched) — this
 * only lets a tenant rename what the tiers are CALLED, via SystemConfig key
 * `pricing.tierLabels` (see `system-config.service.ts#getPricingTierLabels`). A
 * blank/whitespace-only configured label is treated as unset. The web and
 * mobile mirrors (`apps/web/lib/tier-label.ts`, `apps/mobile/lib/tier-label.ts`)
 * keep an identical copy of this function — change all three together.
 * Behavior locked by `tier-label.spec.ts`.
 */
export function tierLabel(
  labels: Record<string, string> | null | undefined,
  n: number | string | null | undefined,
): string {
  const key = String(n ?? "");
  const custom = labels?.[key]?.trim();
  if (custom) return custom;
  const num = Number(key);
  return Number.isFinite(num) && num >= 1 ? `Tier ${num}` : "Tier ?";
}
