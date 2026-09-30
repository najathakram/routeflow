/**
 * Integer quantity input hygiene for order / invoice line entry.
 *
 * Quantities are always whole units (or whole boxes/pieces). On Android the
 * `number-pad` keyboard can still surface a decimal/minus key, and a raw text
 * field happily keeps a typed leading zero ("05"). Both produce surprising
 * totals downstream, so every qty/boxes/pieces TextInput in the create + edit
 * flows routes its `onChangeText` through {@link sanitizeIntInput}.
 *
 * Pairs with `normalizeBoxesPieces` (`@routeflow/pricing`)
 * which is authoritative — this just keeps what the operator SEES integer-clean.
 */

/**
 * Coerce free-typed text into a clean non-negative integer string:
 * - drops anything from a decimal separator onward ("1.5" → "1"),
 * - strips every non-digit,
 * - removes leading zeros ("05" → "5", "007" → "7"), keeping a lone "0",
 * - returns "" for empty input so the field can show a blank while editing.
 */
export function sanitizeIntInput(text: string | null | undefined): string {
  if (text == null) return "";
  const intPart = String(text).split(/[.,]/)[0];
  const digits = intPart.replace(/\D+/g, "");
  if (digits === "") return "";
  return digits.replace(/^0+(?=\d)/, "");
}

/** Parse free-typed text to a non-negative integer, falling back when blank. */
export function parseIntQty(text: string | null | undefined, fallback = 0): number {
  const s = sanitizeIntInput(text);
  if (s === "") return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve a qty draft at commit time (blur). Returns the number to commit, or
 * null → revert to the current value.
 * - empty draft: 0 when emptyMeansZero (line-removal semantics), else revert.
 * - below min (e.g. typed "0" on a min-1 surface): revert.
 * - above max: clamp (matches the cart sheet's pieces field — no rollover).
 */
export function commitQtyDraft(
  draft: string | null | undefined,
  opts: { min?: number; max?: number; emptyMeansZero?: boolean } = {},
): number | null {
  const { min = 0, max, emptyMeansZero = true } = opts;
  const clean = sanitizeIntInput(draft);
  if (clean === "") return emptyMeansZero ? Math.max(0, min) : null;
  const n = parseInt(clean, 10);
  if (!Number.isFinite(n) || n < min) return null;
  return max != null ? Math.min(max, n) : n;
}
