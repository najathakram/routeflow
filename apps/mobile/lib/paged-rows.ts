/**
 * Flatten the pages of an infinite query into one list, dropping duplicates.
 *
 * Offset pagination re-emits a row when the underlying set shifts between page
 * fetches (someone edits a product mid-scroll). Duplicate keys crash FlatList,
 * so de-duping is not optional — `products/index.tsx` learned this the hard way.
 */
export function flattenPages<T extends { id: string }>(
  pages: Array<{ data: T[] }> | undefined,
): T[] {
  if (!pages?.length) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const row of page?.data ?? []) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

/**
 * Index the rows a screen can price and total: the current page, plus snapshots
 * of lines added earlier that the page no longer contains.
 *
 * The live page wins on conflict — a snapshot is only ever a fallback, so an
 * edited price still shows through. Without the snapshot half, a line added
 * from page 3 (or before a search narrowed the list) silently drops out of the
 * footer total.
 */
export function mergeProductIndex<T>(
  pageRows: Array<T & { id: string }>,
  snapshots: Record<string, T>,
): Map<string, T> {
  const index = new Map<string, T>();
  for (const [id, snapshot] of Object.entries(snapshots)) index.set(id, snapshot);
  for (const row of pageRows) index.set(row.id, row);
  return index;
}
