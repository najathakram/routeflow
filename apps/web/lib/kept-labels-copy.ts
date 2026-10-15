/**
 * H2: moving a variant to another parent (or unlinking it) keeps the labels it carried through the old parent as its own,
 * so a selling restriction never silently stops applying. The API reports the kept label NAMES (`keptLabels`); this is the
 * fixed sentence around them. Label names are the tenant's own data; no server message text is ever shown.
 */
export function keptLabelsNote(labels: readonly string[] | null | undefined): string | null {
  if (!labels || labels.length === 0) return null;
  const quoted = labels.map((l) => `"${l}"`).join(", ");
  return `Kept the label${labels.length === 1 ? "" : "s"} ${quoted} on this product.`;
}

/** The bulk "group as variants" result: one sentence counting the products that kept something. */
export function keptLabelsNoteForBulk(
  kept: ReadonlyArray<{ id: string; labels: string[] }> | null | undefined,
): string | null {
  if (!kept || kept.length === 0) return null;
  return kept.length === 1
    ? "1 product kept a label it had through its old parent."
    : `${kept.length} products kept labels they had through their old parent.`;
}
