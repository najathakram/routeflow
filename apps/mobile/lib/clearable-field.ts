/**
 * Edit payloads that can CLEAR an optional text field. `|| undefined` made an emptied field a
 * silent no-op, so a stored phone / currency / notes / taxId could never be removed. Mirrors web's
 * `clearableField` (apps/web/lib/contact-person-payload.ts).
 */

/** The trimmed value; an explicit `null` when a value the form LOADED was emptied; `undefined`
 *  (leave alone) when there was nothing to clear. */
export function clearableField(
  next: string | null | undefined,
  loaded: string | null | undefined,
): string | null | undefined {
  const value = next?.trim();
  if (value) return value;
  return loaded?.trim() ? null : undefined;
}

/** Create omits empty fields (`undefined`); edit can clear a loaded value (`null`). */
export function optionalText(
  mode: "create" | "edit",
  next: string,
  loaded: string | null | undefined,
): string | null | undefined {
  return mode === "edit" ? clearableField(next, loaded) : next.trim() || undefined;
}
