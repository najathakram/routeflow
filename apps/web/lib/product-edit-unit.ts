/**
 * The `unit` (pack word) a product-form save may send. Only a word the operator actually changed:
 * a form opened before a Settings > Units rename holds the OLD word, and sending it back would
 * silently undo the rename on that product. Blank = leave unchanged.
 */
export function packWordToSend(
  draftUnit: string | undefined,
  unitWhenEditStarted: string | undefined,
): string | undefined {
  const next = draftUnit?.trim();
  if (!next || next === (unitWhenEditStarted ?? "").trim()) return undefined;
  return draftUnit;
}
