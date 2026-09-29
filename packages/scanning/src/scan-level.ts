import { defaultSellLevel, type SellLevel } from "@routeflow/pricing";
import { normalizeScanCode } from "./barcode-normalize";

/**
 * #2717 M4a-1 — the ONE pure scan-level resolver (SA-580 owner rule; replaces SA-572a (i) and
 * pricing's retired `lineMode` resolver).
 *
 * The LEVEL comes from the CODE, never from the line's mode:
 *   R1  a code that resolves only at UNIT -> UNIT; only at BOX -> BOX.
 *   R2  a SHARED code (both levels) -> BOX. There is no per-customer default unit (R3), so no proxy.
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

/** Level for a staff scan, given the set of levels the hit code has on the product. Total. */
export function resolveScanSellLevel(
  product: { unitsPerBox?: number | null },
  levels: readonly SellLevel[],
): SellLevel {
  if (levels.includes("BOX")) return "BOX";
  if (levels.includes("UNIT")) return "UNIT";
  return defaultSellLevel({ unitsPerBox: product.unitsPerBox });
}

/** SA-580a: buyer surfaces add the default unit only, whatever level the code resolved to. */
export function resolveBuyerScanSellLevel(product: { unitsPerBox?: number | null }): SellLevel {
  return defaultSellLevel({ unitsPerBox: product.unitsPerBox });
}

/**
 * The levels the scanned `code` has on `product`. `barcodes[]` rows are authoritative when present
 * (non-empty); otherwise the legacy columns, exactly as M1 synthesizes them: barcode -> BOX+UNIT
 * when upb > 1 else UNIT; sku -> BOX; unitSku -> UNIT. Matching is case-insensitive over the
 * `normalizeScanCode` candidate set. No match -> [].
 */
export function levelsForScannedCode(code: string, product: ScanLevelProduct): SellLevel[] {
  const candidates = new Set(normalizeScanCode(code).map((c) => c.toLowerCase()));
  const hit = (v: string | null | undefined): boolean =>
    typeof v === "string" && v.length > 0 && candidates.has(v.trim().toLowerCase());
  const found = new Set<SellLevel>();

  if (product.barcodes && product.barcodes.length > 0) {
    for (const row of product.barcodes) if (hit(row.code)) found.add(row.level);
  } else {
    const boxed = typeof product.unitsPerBox === "number" && product.unitsPerBox > 1;
    if (hit(product.barcode)) {
      found.add("UNIT");
      if (boxed) found.add("BOX");
    }
    if (hit(product.sku)) found.add("BOX");
    if (hit(product.unitSku)) found.add("UNIT");
  }
  return [...found];
}
