import { normalizeScanCode } from "../common/barcode-normalize";

/**
 * Candidate-aware product search for the SCAN fallback rung (`GET
 * /products?scanCode=`). Lives here — NOT in common/barcode-normalize.ts —
 * because that file is byte-compared against its mobile mirror by
 * apps/mobile/__tests__/barcode-normalize.test.ts and this builder is
 * server-only (clients never construct Prisma where-clauses).
 *
 * Why it exists: the clients' resolve ladder falls back to `search=<raw code>`
 * when the barcode endpoint 404s — but `contains` on the RAW decode misses
 * every stored shape that differs from this camera's decode of the label. The
 * canonical case: iOS reports a UPC-A as 13 digits with a leading zero, so a
 * catalogue whose printed 12-digit code lives in the product NAME (numeric-name
 * tenants) contains-misses on iPhone while a desktop 12-digit scan of the same
 * label hits. Fanning the normalizeScanCode candidates into the contains-search
 * makes the fallback rung decoder-independent, exactly like the barcode
 * endpoint has been since PR #323.
 */

/** OR-clause budget: 5 candidates × 4 columns = 20 ILIKEs, only on the rare
 *  post-404 fallback path. Candidates are ordered most→least canonical, so the
 *  cap drops only the exotic tail (check-digit-stripped forms). */
export const MAX_SCAN_SEARCH_CANDIDATES = 5;

/**
 * Prisma OR clauses for one scanned code: every normalizeScanCode candidate,
 * contains-matched (case-insensitive) over the four code-bearing columns the
 * regular `search=` predicate uses. Returns [] for blank/garbage input —
 * Prisma treats `OR: []` as matching nothing, which is the right answer for
 * an empty scan.
 */
export function buildScanSearchOr(code: string): Array<Record<string, unknown>> {
  const candidates = normalizeScanCode(code).slice(0, MAX_SCAN_SEARCH_CANDIDATES);
  return candidates.flatMap((c) => [
    { name: { contains: c, mode: "insensitive" } },
    { sku: { contains: c, mode: "insensitive" } },
    { barcode: { contains: c, mode: "insensitive" } },
    { unitSku: { contains: c, mode: "insensitive" } },
  ]);
}
