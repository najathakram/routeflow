/**
 * B1282: the ONE rule for which override row applies to a feature key. A row applies only while it is live (no expiry, or an
 * expiry in the future); an expired row never supplies an effect. When more than one live row names the same key, the FIRST
 * one in the read's order wins. The partial unique index keeps that tie out of real data today (one non-revoked row per key);
 * the rule is still defined once, so the served answer (`FeatureOverrideService`) and the pilot-ending job's "what else is
 * served" read cannot disagree if the index is ever relaxed.
 */
export type OverrideRuleRow<E extends string = string> = {
  featureKey: string;
  effect: E;
  expiresAt: Date | null;
};

/** True while the row can still supply an effect at `nowMs`. */
export const isLiveOverride = (row: { expiresAt?: Date | null }, nowMs: number): boolean =>
  row.expiresAt == null || row.expiresAt.getTime() > nowMs;

/** The row that applies to `featureKey`, or null. */
export function pickLiveRow<R extends OverrideRuleRow>(
  rows: readonly R[],
  featureKey: string,
  nowMs: number,
): R | null {
  return rows.find((r) => r.featureKey === featureKey && isLiveOverride(r, nowMs)) ?? null;
}

/** Every key's applying effect: the first live row per key. */
export function resolveLiveEffects<E extends string>(
  rows: readonly OverrideRuleRow<E>[],
  nowMs: number,
): Map<string, E> {
  const out = new Map<string, E>();
  for (const row of rows) {
    if (!out.has(row.featureKey) && isLiveOverride(row, nowMs)) out.set(row.featureKey, row.effect);
  }
  return out;
}
