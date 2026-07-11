/**
 * Pure (screen-free, testable) filter behind the mobile CategoryInput
 * suggestions — case-insensitive substring match over the tenant's existing
 * categories, capped so the dropdown stays scannable. An exact (case-insensitive)
 * match is excluded: the field already holds it, suggesting it again is noise.
 */
export function filterCategorySuggestions(
  all: string[] | undefined,
  query: string,
  cap = 8,
): string[] {
  const list = all ?? [];
  const q = query.trim().toLowerCase();
  const matches = q
    ? list.filter((c) => c.toLowerCase().includes(q) && c.toLowerCase() !== q)
    : list;
  return matches.slice(0, cap);
}
