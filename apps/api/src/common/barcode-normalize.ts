/**
 * Scanned-code normalisation: turn one decoded string into the ORDERED list of
 * strings it might be stored as, best guess first, for matching against
 * `Product.barcode` / `.sku` / `.unitSku`.
 *
 * WHY A LIST AND NOT ONE STRING
 * -----------------------------
 * The same physical label reaches us as different strings depending on the
 * decoder. iOS AVFoundation has no UPC-A symbology, so a UPC-A scanned on an
 * iPhone is reported as a 13-digit EAN-13 with a leading zero; the web
 * `BarcodeDetector` and zxing both report the same label as 12 digits. A
 * catalogue seeded from one source therefore never matches a scan from the
 * other, and the operator sees "item not found" for a product that exists.
 *
 * Ordering is load-bearing: `pickBestScanMatch` resolves ties by candidate
 * position, so the closest-to-literal interpretation always wins. The
 * check-digit-stripped form is deliberately last — an 11-digit prefix can
 * collide with an unrelated SKU, so it must only ever win when nothing else
 * matched at all.
 *
 * MIRROR: `apps/mobile/lib/barcode-normalize.ts` — change both together.
 * (Same discipline as `pricing.ts`. Mobile needs its own copy for the
 * in-memory fast path, which never reaches the server.)
 */

/** Hard cap on the candidate list, so a lookup can never fan out unboundedly. */
export const MAX_SCAN_CANDIDATES = 10;

const DIGITS = /^\d+$/;

/**
 * Expand a compressed UPC-E (8 digits: number system + 6 data + check) to its
 * UPC-A (12 digit) equivalent. Returns null when `code` isn't a UPC-E.
 *
 * Only number systems 0 and 1 are compressible; anything else is not UPC-E.
 */
export function upcEToUpcA(code: string): string | null {
  if (code.length !== 8 || !DIGITS.test(code)) return null;
  const system = code[0];
  if (system !== "0" && system !== "1") return null;
  const d = code.slice(1, 7);
  const check = code[7];
  let middle: string;
  switch (d[5]) {
    case "0":
    case "1":
    case "2":
      middle = `${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}`;
      break;
    case "3":
      middle = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
      break;
    case "4":
      middle = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
      break;
    default: // 5-9
      middle = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${d[5]}`;
      break;
  }
  return `${system}${middle}${check}`;
}

/**
 * Length-driven GTIN equivalences. One hop each, no recursion, so the list
 * stays small and predictable.
 */
function numericVariants(n: string): string[] {
  const out: string[] = [];
  if (n.length === 8) {
    const upcA = upcEToUpcA(n);
    if (upcA) out.push(upcA, `0${upcA}`); // UPC-A, then its EAN-13 form
  }
  if (n.length === 12) out.push(`0${n}`); // UPC-A -> EAN-13
  if (n.length === 13 && n.startsWith("0")) out.push(n.slice(1)); // EAN-13 -> UPC-A
  if (n.length === 14 && n.startsWith("0")) {
    // GTIN-14 / ITF-14 case code -> the inner GTIN
    const thirteen = n.slice(1);
    out.push(thirteen);
    if (thirteen.startsWith("0")) out.push(thirteen.slice(1));
  }
  const stripped = n.replace(/^0+/, "");
  if (stripped && stripped !== n) out.push(stripped);
  // LAST, deliberately: some legacy catalogues store the GTIN without its
  // check digit. Ranked below everything else because the truncated form can
  // collide with an unrelated code.
  if ([8, 12, 13, 14].includes(n.length)) out.push(n.slice(0, -1));
  return out;
}

/**
 * Ordered, de-duplicated candidate strings for a scanned or typed code.
 * Returns `[]` for blank input.
 */
export function normalizeScanCode(raw: string): string[] {
  const exact = (raw ?? "").trim();
  if (!exact) return [];

  const out: string[] = [exact];
  const upper = exact.toUpperCase();
  if (upper !== exact) out.push(upper);
  // Wedge scanners append \r / \t; printed labels get typed back with spaces
  // and hyphens. The un-stripped forms stay first — "TOM-001" is a real SKU
  // shape, and stripping must never outrank the literal.
  const alnum = upper.replace(/[^0-9A-Z]/g, "");
  if (alnum && alnum !== upper) out.push(alnum);
  if (DIGITS.test(alnum)) out.push(...numericVariants(alnum));

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of out) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    deduped.push(candidate);
  }
  return deduped.slice(0, MAX_SCAN_CANDIDATES);
}

/** The subset of a product row this module needs to rank a match. */
export interface ScanMatchable {
  id: string;
  barcode?: string | null;
  sku?: string | null;
  unitSku?: string | null;
}

/**
 * Deterministic winner among rows that matched any candidate.
 *
 * Precedence: earlier candidate beats later; within one candidate,
 * `barcode` > `sku` > `unitSku`; ties break on `id` so the answer never flips
 * between identical requests.
 */
export function pickBestScanMatch<T extends ScanMatchable>(rows: T[], candidates: string[]): T {
  const upper = candidates.map((c) => c.toUpperCase());
  const rank = (row: T): number => {
    for (let i = 0; i < upper.length; i++) {
      if ((row.barcode ?? "").toUpperCase() === upper[i]) return i * 3;
      if ((row.sku ?? "").toUpperCase() === upper[i]) return i * 3 + 1;
      if ((row.unitSku ?? "").toUpperCase() === upper[i]) return i * 3 + 2;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0];
}
