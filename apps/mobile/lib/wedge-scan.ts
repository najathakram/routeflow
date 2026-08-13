/**
 * Hardware ("wedge") barcode scanners type the code into whatever field has
 * focus — on the order/invoice builders that's the product SEARCH box. Until
 * now that path dead-ended in a suggestion the operator had to TAP, then
 * clear, then rescan (owner-reported by a live wholesaler). These pure
 * helpers decide when typed search text should behave like a SCAN:
 *
 * - `looksLikeScanCode` gates Enter-as-scan and the auto-add fallback to
 *   digit codes (EAN-8/UPC-A/EAN-13…), so pressing Enter after typing a
 *   product NAME never adds anything.
 * - `findExactScanMatch` mirrors the camera path's local fast-path: the
 *   normalizeScanCode candidate set against barcode/sku/unitSku/id, but adds
 *   the SINGLE-match requirement — two products sharing a code is a data
 *   problem a human should resolve, not a coin flip.
 */
import { normalizeScanCode } from "./barcode-normalize";

/** Digit-only, ≥8 chars (shortest real barcode is EAN-8). Spaces trimmed. */
export function looksLikeScanCode(term: string): boolean {
  const t = term.trim();
  return t.length >= 8 && /^\d+$/.test(t);
}

export interface ScanMatchable {
  id?: string | null;
  barcode?: string | null;
  sku?: string | null;
  unitSku?: string | null;
}

export interface ExactScanMatch<T> {
  /** The one product whose code matches — null when none or several do. */
  match: T | null;
  /** True when MORE than one product matched (leave the list for a tap). */
  multiple: boolean;
}

export function findExactScanMatch<T extends ScanMatchable>(
  term: string,
  products: readonly T[],
): ExactScanMatch<T> {
  const trimmed = term.trim();
  if (!trimmed) return { match: null, multiple: false };
  const candidates = new Set(normalizeScanCode(trimmed).map((c) => c.toUpperCase()));
  const hit = (v?: string | null) => !!v && candidates.has(v.toUpperCase());
  const matches = products.filter(
    (p) =>
      hit(p.barcode) ||
      hit(p.sku) ||
      hit(p.unitSku) ||
      (p.id ?? "").toLowerCase() === trimmed.toLowerCase(),
  );
  if (matches.length === 1) return { match: matches[0], multiple: false };
  return { match: null, multiple: matches.length > 1 };
}
