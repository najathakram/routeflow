/**
 * Mobile mirror of `apps/api/src/common/tier-label.ts#tierLabel` — keep in sync.
 * Configured tenant label for a pricing tier, hard-falling back to "Tier N".
 * A blank/whitespace-only configured label is treated as unset. Behavior
 * locked by `apps/api/src/common/tier-label.spec.ts`.
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
