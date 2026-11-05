/**
 * B1282: the ONE rule for which override row applies to a feature key. A row applies only while it is live (no expiry, or an
 * expiry in the future); an expired row never supplies an effect. When more than one live row names the same key, the FIRST
 * one in the read's order wins, and the read's order is ONE order (`OVERRIDE_RULE_ORDER`), so "first" means "newest" for
 * every reader. The partial unique index keeps that tie out of real data today (one non-revoked row per key); the rule is
 * still defined once, so the served answer (`FeatureOverrideService`), the business-profile screen and the pilot-ending job's
 * "what else is served" read cannot disagree if the index is ever relaxed. Every read that feeds the rule passes
 * `orderBy: OVERRIDE_RULE_ORDER` (pinned in `feature-override-one-rule.class.spec.ts`).
 */
export type OverrideRuleRow<E extends string = string> = {
  featureKey: string;
  effect: E;
  expiresAt: Date | null;
};

/**
 * The one order every read that feeds the rule uses, so "the first live row" is the same row everywhere: the newest
 * (`createdAt` desc), and on a `createdAt` tie the higher id (`id` desc), so the newest row wins in every reader.
 */
export const OVERRIDE_RULE_ORDER = [{ createdAt: "desc" as const }, { id: "desc" as const }];

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
  for (const [key, row] of resolveLiveRows(rows, nowMs)) out.set(key, row.effect);
  return out;
}
/** Every key's applying ROW: the first live row per key (the row twin of {@link resolveLiveEffects}). */
export function resolveLiveRows<R extends OverrideRuleRow>(
  rows: readonly R[],
  nowMs: number,
): Map<string, R> {
  const out = new Map<string, R>();
  for (const row of rows) {
    if (!out.has(row.featureKey) && isLiveOverride(row, nowMs)) out.set(row.featureKey, row);
  }
  return out;
}
