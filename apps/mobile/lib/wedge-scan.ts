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
 *   normalizeScanCode candidate set against barcode/sku/unitSku/cached barcodes[] rows/id, but adds
 *   the SINGLE-match requirement — two products sharing a code is a data
 *   problem a human should resolve, not a coin flip.
 */
import type { SellLevel } from "@routeflow/pricing";
import {
  levelsForScannedCode,
  normalizeScanCode,
  scanMatchIsForCode,
  type ScanBarcodeRow,
} from "@routeflow/scanning";

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
  /** M1 `ProductBarcode` rows carried by the list/detail payload (additive; absent on old rows). */
  barcodes?: readonly ScanBarcodeRow[] | null;
  /** Absent/null/undefined is treated as active — only an explicit `false` excludes a row. */
  isActive?: boolean | null;
}

export interface ExactScanMatch<T> {
  /** The one product whose code matches — null when none or several do. */
  match: T | null;
  /** True when MORE than one product matched (leave the list for a tap). */
  multiple: boolean;
}

/**
 * The levels the scanned `term` has on a resolved `product` (#2717 M4a-1, SA-580). The server's
 * `scanMatch.levels` wins when the row carries one (it saw the row that hit); otherwise the levels
 * come from the cached `barcodes[]` / the legacy columns via the shared `levelsForScannedCode`.
 * Callers turn it into a level with `resolveScanSellLevel(product, levels)` (the ONE resolver, in
 * @routeflow/scanning; it replaced this file's old case/piece classifier).
 */
export function levelsForScan(
  term: string,
  product: ScanMatchable & {
    unitsPerBox?: number | null;
    scanMatch?: { code?: string; levels?: readonly SellLevel[] } | null;
  },
): SellLevel[] {
  const fromServer = product.scanMatch?.levels;
  if (fromServer && fromServer.length > 0 && scanMatchIsForCode(term, product.scanMatch?.code)) {
    return [...fromServer];
  }
  return levelsForScannedCode(term.trim(), product);
}

export function findExactScanMatch<T extends ScanMatchable>(
  term: string,
  products: readonly T[],
): ExactScanMatch<T> {
  const trimmed = term.trim();
  if (!trimmed) return { match: null, multiple: false };
  const candidates = new Set(normalizeScanCode(trimmed).map((c) => c.toUpperCase()));
  const hit = (v?: string | null) => !!v && candidates.has(v.toUpperCase());
  // A row cached with isActive:false (archived elsewhere since it was loaded)
  // is never a valid local match — the caller must fall through and let the
  // server rung report the archived verdict, never silently accept a dead row.
  const matches = products.filter(
    (p) =>
      p.isActive !== false &&
      (hit(p.barcode) ||
        hit(p.sku) ||
        hit(p.unitSku) ||
        (p.barcodes ?? []).some((b) => hit(b?.code)) ||
        (p.id ?? "").toLowerCase() === trimmed.toLowerCase()),
  );
  if (matches.length === 1) return { match: matches[0], multiple: false };
  return { match: null, multiple: matches.length > 1 };
}
