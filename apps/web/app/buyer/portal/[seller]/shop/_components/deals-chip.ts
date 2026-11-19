/**
 * UX guide B18: a "Deals" row that matches the whole catalog filters nothing.
 * `dealsWhere` returns `{}` for a store-wide (ALL-scope) promotion, so the
 * wire count equals `total`. The API count stays true; both web chip sites
 * (rail + mobile chip strip) ask this one predicate whether to show the row.
 * A URL that already selects `collection=deals` still lists every deal.
 */
export function showsDealsChip(counts: { total: number; collections: { deals: number } }): boolean {
  return counts.collections.deals > 0 && counts.collections.deals < counts.total;
}
