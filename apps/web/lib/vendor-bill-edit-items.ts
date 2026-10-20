/**
 * B292: the API refuses an edit whose `items` is an empty list (it would clear every line), and
 * treats an ABSENT `items` as "keep the lines". A header-only bill opens in the editor with no
 * rows, so a header edit (notes, dates, supplier) must leave `items` out unless the user added a
 * line. A bill that HAD lines and now has none still sends `[]` so the server says why it is refused.
 */
export function editItemsField<T>(
  items: readonly T[],
  originalLineCount: number,
): { items: T[] } | Record<string, never> {
  return items.length > 0 || originalLineCount > 0 ? { items: [...items] } : {};
}
