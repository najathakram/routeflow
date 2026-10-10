/**
 * THE unit-label normaliser (SA-408b): every unit-label compare goes through it (trim + lowercase),
 * so "case", " Case" and "CASE" are one unit. Pure and import-free on purpose: the Nest-free
 * selling-restrictions module (order-edit-lines.ts) and the Nest-aware products/line-units.ts both
 * import it, and neither may drag the other's dependencies along.
 */
export const norm = (s: string): string => s.trim().toLowerCase();

/**
 * SA-070 / #2288: THE keep-held-unit rule — whether an edit of a line HELD in a unit keeps that
 * unit. ABSENT (`undefined`) keeps it; the same label re-sent (through `norm`) keeps it; an explicit
 * cleared label (null / "" / blank) or another label does not (the write re-denominates the line,
 * to the pack or to that unit). A line with no held unit keeps nothing. Both the write
 * (products/line-units.ts resolveLineUnits) and the restriction netting
 * (selling-restrictions/order-edit-lines.ts unitLineEdit) call this, so they can never disagree.
 */
export function keepsHeldUnit(
  explicit: string | null | undefined,
  held: string | null | undefined,
): boolean {
  const h = (held ?? "").trim();
  if (h === "") return false;
  if (explicit === undefined) return true;
  const asked = (explicit ?? "").trim();
  return asked !== "" && norm(asked) === norm(h);
}
