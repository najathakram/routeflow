/**
 * Presentation-shaping logic for the mobile pack-size prompt (PackSizeSheet).
 *
 * This module does NOT parse product names or decide confidence — that lives
 * once, canonically, in `@routeflow/types` (`suggestPackSize` /
 * `parsePackSizeDetailed`, ported from `apps/api/scripts/propose-pack-sizes.mjs`).
 * All this file does is turn an already-computed `PackSizeSuggestion` into
 * what the sheet shows: copy + the value the number input should start with.
 *
 * The one rule worth guarding with tests: AMBIGUOUS and LOW never pre-fill a
 * number. Guessing between two counts (e.g. "…5CT - 12Pack") mis-prices every
 * loose sale of that product — worse than leaving the field blank and asking.
 */
import type { PackSizeSuggestion } from "@routeflow/types";

export interface PackSizePrompt {
  /** Operator-facing copy shown above the input. Never phrased as a guess. */
  message: string;
  /**
   * What the number input starts pre-filled with. Empty string means "make
   * the operator type it" — used for AMBIGUOUS and LOW, where a pre-filled
   * number would look like a confident answer it isn't.
   */
  initialValue: string;
}

/**
 * Turns a `suggestPackSize()` result into prompt copy for the mobile sheet,
 * or `null` when nothing should be shown at all. The operator-facing message
 * always comes from the parser's own `reason` — this function's only job is
 * deciding WHETHER to show a prompt and what the input should start with.
 *
 * - No suggestion, or `confidence: null` (unitsPerBox already set / nothing
 *   detected) -> no prompt.
 * - `PIECE_UNIT` -> no prompt. A piece-priced row must never be turned boxed;
 *   the count in the name describes the case it was broken out of.
 * - `AMBIGUOUS` -> state the conflict, EMPTY initial value. Never guess
 *   between the two counts.
 * - `HIGH` / `MEDIUM` -> pre-fill the single count the parser found.
 * - `LOW` -> quiet ask, empty initial value (a packish unit with no count).
 */
export function packSizePromptFor(
  suggestion: PackSizeSuggestion | null | undefined,
): PackSizePrompt | null {
  if (!suggestion || suggestion.confidence == null) return null;
  if (suggestion.confidence === "PIECE_UNIT") return null;

  const initialValue =
    (suggestion.confidence === "HIGH" || suggestion.confidence === "MEDIUM") &&
    suggestion.packSize != null
      ? String(suggestion.packSize)
      : "";

  return {
    message: suggestion.reason ?? "Set the pack size for this product?",
    initialValue,
  };
}

/**
 * Parse an operator-typed pack size into a usable `unitsPerBox`, or null.
 *
 * Lives here rather than beside the sheet that renders it because
 * `jest.config.js` only transforms pure `.ts` logic — a copy inside a `.tsx`
 * component is unreachable from the test suite, and this guard is exactly the
 * kind that has already shipped a bug once.
 *
 * Floor BEFORE validating, never after: comparing the raw typed value against
 * the bound and only flooring on the way out let "1.5" slip past `n <= 1`
 * (1.5 > 1) and return `Math.floor(1.5)` = 1 — precisely the meaningless
 * "no packaging" value the guard exists to reject, and one the web surface
 * refuses outright.
 */
export function parsePackSize(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Math.floor(Number(t));
  if (!Number.isFinite(n) || n < 2 || n > 1000) return null;
  return n;
}
