import { defaultSellLevel, type SellLevel } from "@routeflow/pricing";
import { normalizeScanCode } from "./barcode-normalize";

/**
 * #2717 M4a-1 — the ONE pure scan-level resolver (SA-580 owner rule, R2 replaced by SA-580b;
 * replaces SA-572a (i) and pricing's retired `lineMode` resolver).
 *
 * The LEVEL comes from the CODE, never from the line's mode:
 *   R1  a code that resolves only at UNIT -> UNIT; only at BOX -> BOX.
 *   R2  (SA-580b) a SHARED code (both levels) -> the product's DEFAULT SELL UNIT, i.e.
 *       `defaultSellLevel({ unitsPerBox })`: upb > 1 -> BOX, else UNIT. (Was a fixed BOX in SA-580.)
 *       There is still no per-customer default unit (R3).
 *   R4  upb <= 1 has no box/unit distinction: the raw level is still BOX|UNIT and total; the CLIENT
 *       keeps today's line shape for that product (SA-578 Q2(a)).
 * Code -> product stays the server's job: every function here takes ONE product.
 */

/** A `ProductBarcode` row as the scan path sees it. */
export interface ScanBarcodeRow {
  code: string;
  level: SellLevel;
}

export interface ScanLevelProduct {
  barcode?: string | null;
  sku?: string | null;
  unitSku?: string | null;
  unitsPerBox?: number | null;
  barcodes?: readonly ScanBarcodeRow[] | null;
}

/**
 * SA-626: a code that resolves at BOTH levels is "shared". The ONE rule web and mobile both call to decide
 * whether a new scan line may start on the product's default selling unit (a box-only / unit-only code never does).
 */
export function isSharedScanCode(levels: readonly SellLevel[]): boolean {
  return levels.includes("BOX") && levels.includes("UNIT");
}

/** Level for a staff scan, given the set of levels the hit code has on the product. Total. */
export function resolveScanSellLevel(
  product: { unitsPerBox?: number | null },
  levels: readonly SellLevel[],
): SellLevel {
  const box = levels.includes("BOX");
  const unit = levels.includes("UNIT");
  if (box && unit) return defaultSellLevel({ unitsPerBox: product.unitsPerBox });
  if (box) return "BOX";
  if (unit) return "UNIT";
  return defaultSellLevel({ unitsPerBox: product.unitsPerBox });
}

// SA-580a: buyer surfaces (mobile (customer)/scan.tsx) add the default selling unit only, whatever
// level the code resolved to. That rule is `cartStore.add` itself (one default unit, boxes for a
// boxed product); no level resolver is involved, so there is deliberately no buyer function here.

/**
 * The levels the scanned `code` has on `product`. `barcodes[]` rows (non-empty) replace only the
 * legacy `barcode` column's contribution (barcode -> BOX+UNIT when upb > 1 else UNIT); `sku` -> BOX
 * and `unitSku` -> UNIT always apply (SA-595). Matching is case-insensitive over the
 * `normalizeScanCode` candidate set. No match -> [].
 */
export function levelsForScannedCode(code: string, product: ScanLevelProduct): SellLevel[] {
  const candidates = new Set(normalizeScanCode(code).map((c) => c.toLowerCase()));
  const hit = (v: string | null | undefined): boolean =>
    typeof v === "string" && v.length > 0 && candidates.has(v.trim().toLowerCase());
  const found = new Set<SellLevel>();

  // SA-595: rows supersede ONLY the barcode-column contribution; sku -> BOX and unitSku -> UNIT
  // always resolve (the server and every client share this one derivation).
  if (product.barcodes && product.barcodes.length > 0) {
    // Only BOX/UNIT rows carry a level; any other string on a row never becomes one.
    for (const row of product.barcodes) {
      if ((row.level === "BOX" || row.level === "UNIT") && hit(row.code)) found.add(row.level);
    }
  } else if (hit(product.barcode)) {
    found.add("UNIT");
    if (typeof product.unitsPerBox === "number" && product.unitsPerBox > 1) found.add("BOX");
  }
  if (hit(product.sku)) found.add("BOX");
  if (hit(product.unitSku)) found.add("UNIT");
  return [...found];
}

/**
 * A server `scanMatch` is stamped by the FIRST scan that resolved a product, and the builders snapshot
 * that row; its `levels` are evidence for `matchCode` only. A later scan of ANOTHER code on the same
 * product must derive its own levels (box code, then unit code -> must not add a case). The two codes
 * agree when they share a `normalizeScanCode` candidate (UPC-A vs EAN-13 forms of one code). A stub with
 * no code (the server always sends one) cannot be disproved and is taken as-is.
 */
export function scanMatchIsForCode(code: string, matchCode: string | null | undefined): boolean {
  if (!matchCode) return true;
  const mine = new Set(normalizeScanCode(code.trim()).map((c) => c.toLowerCase()));
  return normalizeScanCode(matchCode.trim()).some((c) => mine.has(c.toLowerCase()));
}
