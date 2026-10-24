import { BarcodeOrigin, BarcodeSymbology, PackagingLevel } from "@prisma/client";
import type { ProductBarcodeView, ProductImageView } from "@routeflow/types";
import { defaultSellLevel } from "@routeflow/pricing";
import { inferBarcodeSymbology } from "../common/barcode-symbology";
import { signableImageKeys } from "./product-image-keys";

/** #2717 M1 (SA-572a): a single planned/persisted ProductBarcode row. */
export interface PlannedBarcodeRow {
  code: string;
  level: PackagingLevel;
  symbology: BarcodeSymbology;
  origin: BarcodeOrigin;
  copiedFromLevel: PackagingLevel | null;
  primaryFor: PackagingLevel | null;
}

/** `-fp50x40` → focal point 50% across, 40% down (products.service.ts:39-53 encodeFocalSuffix). */
function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 50;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

/**
 * The owner's rule (SA-572a): a product's legacy barcode becomes its level rows. unitsPerBox > 1 ⇒ BOX (ENTERED) +
 * UNIT (COPIED from BOX, same code), each the primary of its level; otherwise ONE UNIT row (ENTERED). No code ⇒ none.
 * The code is stored exactly as the legacy column holds it (untrimmed identity), but a blank/whitespace code is none.
 * #2717 M1.
 */
export function planBarcodeRows(input: {
  barcode: string | null | undefined;
  unitsPerBox: number | null | undefined;
}): PlannedBarcodeRow[] {
  const { barcode, unitsPerBox } = input;
  if (!barcode || barcode.trim().length === 0) return [];

  const symbology = inferBarcodeSymbology(barcode);
  // One rule for "boxed" (L-167): the same predicate the scan-level resolution reads.
  const isBoxed = defaultSellLevel({ unitsPerBox }) === "BOX";

  if (isBoxed) {
    return [
      {
        code: barcode,
        level: "BOX",
        symbology,
        origin: "ENTERED",
        copiedFromLevel: null,
        primaryFor: "BOX",
      },
      {
        code: barcode,
        level: "UNIT",
        symbology,
        origin: "COPIED",
        copiedFromLevel: "BOX",
        primaryFor: "UNIT",
      },
    ];
  }

  return [
    {
      code: barcode,
      level: "UNIT",
      symbology,
      origin: "ENTERED",
      copiedFromLevel: null,
      primaryFor: "UNIT",
    },
  ];
}

/**
 * SA-572a (ii): the unit barcode prints iff a UNIT row that is the UNIT primary exists — COPIED counts. Returns its
 * code. #2717 M1.
 */
export function printableUnitBarcode(
  rows: Array<{ code: string; level: string; primaryFor: string | null }>,
): string | null {
  const row = rows.find((r) => r.level === "UNIT" && r.primaryFor === "UNIT");
  return row ? row.code : null;
}

/**
 * The inverse of products.service.ts's encodeFocalSuffix: `…-fp{x}x{y}.<ext>` → {x,y} clamped to 0..100; no/invalid
 * suffix ⇒ null (centre). #2717 M1.
 */
export function parseFocalFromKey(storageKey: string): { x: number; y: number } | null {
  const basename = storageKey.slice(storageKey.lastIndexOf("/") + 1);
  const match = basename.match(/-fp(\d+)x(\d+)(?:\.[^./]*)?$/);
  if (!match) return null;
  return { x: clampPct(Number(match[1])), y: clampPct(Number(match[2])) };
}

/**
 * SA-572b Q5: the read-model fallback for a product with NO ProductBarcode rows — planBarcodeRows of the legacy
 * column, flagged origin "LEGACY" (never persisted). #2717 M1.
 */
export function synthesizeLegacyBarcodes(p: {
  barcode: string | null;
  unitsPerBox: number | null;
}): ProductBarcodeView[] {
  return planBarcodeRows(p).map((row) => ({ ...row, origin: "LEGACY" }));
}

/** Rows → the view (origin = the row's origin). #2717 M1. */
export function barcodeRowsToView(
  rows:
    | PlannedBarcodeRow[]
    | Array<{
        code: string;
        level: PackagingLevel;
        symbology: BarcodeSymbology;
        origin: BarcodeOrigin;
        copiedFromLevel: PackagingLevel | null;
        primaryFor: PackagingLevel | null;
      }>,
): ProductBarcodeView[] {
  return rows.map((row) => ({
    code: row.code,
    level: row.level,
    symbology: row.symbology,
    origin: row.origin,
    copiedFromLevel: row.copiedFromLevel,
    primaryFor: row.primaryFor,
  }));
}

/**
 * #2728 M1 follow-up (SA-572f): the set of `imageKeys` this product's ProductImage rows may ever
 * mirror — its OWN signable keys (`signableImageKeys`; #2533 already excludes another product's/
 * tenant's key), de-duplicated with FIRST occurrence winning and order kept. Legacy (pre-#2533)
 * data can hold the same key twice, which would otherwise hit `@@unique([tenantId, storageKey])`
 * on the second mirrored create. Shared by the dual-write sync, the backfill's image planning, and
 * the read-model fallback so all three agree on exactly which keys a row can exist for.
 */
export function mirrorableImageKeys(
  productId: string,
  imageKeys: readonly string[] | null | undefined,
): string[] {
  const own = signableImageKeys(productId, imageKeys);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of own) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * SA-572b Q5: images from the legacy imageKeys (sortOrder = index, isPrimary = index 0, focal parsed, origin
 * "LEGACY"). `urlFor` supplies presigned URLs. #2717 M1.
 */
export function synthesizeLegacyImages(
  imageKeys: string[],
  urlFor?: (key: string) => string | null,
): ProductImageView[] {
  return imageKeys.map((storageKey, index) => {
    const focal = parseFocalFromKey(storageKey);
    return {
      storageKey,
      url: urlFor ? urlFor(storageKey) : null,
      focalX: focal ? focal.x : null,
      focalY: focal ? focal.y : null,
      sortOrder: index,
      isPrimary: index === 0,
      altText: null,
      origin: "LEGACY",
    };
  });
}

/**
 * SA-603a: `ProductBarcode.code` is NULL once a deactivated product's code is released
 * (`retiredCode` keeps it). A released row is not a live code: every reader skips it.
 */
export function liveBarcodeRows<T extends { code: string | null }>(
  rows: readonly T[] | null | undefined,
): Array<T & { code: string }> {
  return (rows ?? []).filter((r): r is T & { code: string } => r.code != null);
}
