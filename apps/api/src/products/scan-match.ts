import { Logger } from "@nestjs/common";
import type { SellLevel } from "@routeflow/pricing";
import { levelsForScannedCode, pickBestScanMatch } from "@routeflow/scanning";
import type { ProductBarcodeView, ScanMatchView } from "@routeflow/types";
import { barcodeRowsToView, synthesizeLegacyBarcodes } from "./product-barcode-rules";

/**
 * #2717 M4a-1 (SA-578 Q3/Q5, L-167) — the ONE server-side scan lookup, shared by the staff
 * `findByBarcode` and the buyer `scanProduct`. Each caller passes its OWN scope as `baseWhere`; it is
 * applied to every product query, so a ProductBarcode row on a product outside the caller's scope
 * never resolves.
 *
 * Tiers: ProductBarcode rows (`code in candidates`) + legacy barcode/sku/unitSku exact, then — on a
 * miss only — the case-insensitive tier over the same columns. Ranking: a row hit ranks as `barcode`
 * (Q5), then sku, then unitSku, ties on id (`pickBestScanMatch`).
 */
const logger = new Logger("ScanMatch");
const MISS_TAKE = 25;

type Db = any;
interface RowLike {
  productId: string;
  code: string;
  level: SellLevel;
}

export interface ScanMatchResult<P = any> {
  product: P & { barcodes: ProductBarcodeView[] };
  scanMatch: ScanMatchView;
  barcodes: ProductBarcodeView[];
}

const ci = (a: string | null | undefined, b: string): boolean =>
  typeof a === "string" && a.length > 0 && a.trim().toUpperCase() === b.toUpperCase();

/** Lowest candidate index the value matches (candidate order = closest-to-literal first). */
const indexOf = (value: string | null | undefined, candidates: string[]): number =>
  candidates.findIndex((c) => ci(value, c));

export async function findScanMatches(
  db: Db,
  candidates: string[],
  baseWhere: Record<string, unknown> = {},
  include: Record<string, unknown> = {},
): Promise<ScanMatchResult | null> {
  if (candidates.length === 0) return null;
  const productInclude = { ...include, barcodes: true };
  const scoped = (or: unknown[]) =>
    Object.keys(baseWhere).length > 0 ? { AND: [baseWhere, { OR: or }] } : { OR: or };

  // ── exact tier ──
  let rows: RowLike[] = await db.productBarcode.findMany({
    where: { code: { in: candidates } },
  });
  let products: any[] = await db.product.findMany({
    where: scoped([
      ...(rows.length > 0 ? [{ id: { in: [...new Set(rows.map((r) => r.productId))] } }] : []),
      { barcode: { in: candidates } },
      { sku: { in: candidates } },
      { unitSku: { in: candidates } },
    ]),
    include: productInclude,
  });

  // ── case-insensitive tier, MISS ONLY (a seq scan: typed/lowercased alpha codes) ──
  if (products.length === 0) {
    rows = await db.productBarcode.findMany({
      where: { OR: candidates.map((c) => ({ code: { equals: c, mode: "insensitive" as const } })) },
      take: MISS_TAKE,
    });
    products = await db.product.findMany({
      where: scoped([
        ...(rows.length > 0 ? [{ id: { in: [...new Set(rows.map((r) => r.productId))] } }] : []),
        ...candidates.flatMap((c) => [
          { barcode: { equals: c, mode: "insensitive" as const } },
          { sku: { equals: c, mode: "insensitive" as const } },
          { unitSku: { equals: c, mode: "insensitive" as const } },
        ]),
      ]),
      include: productInclude,
      take: MISS_TAKE,
    });
  }
  if (products.length === 0) return null;

  const rowsByProduct = new Map<string, RowLike[]>();
  for (const r of rows) {
    const list = rowsByProduct.get(r.productId) ?? [];
    list.push(r);
    rowsByProduct.set(r.productId, list);
  }

  warnOnRowCollision(rows, candidates);

  // A row code ranks as `barcode`: fold the best-matching row code into the ranking shim.
  const shims = products.map((p) => {
    const rowCodes = (rowsByProduct.get(p.id) ?? []).map((r) => r.code);
    const best = [p.barcode, ...rowCodes]
      .filter((v): v is string => typeof v === "string")
      .map((v) => ({ v, i: indexOf(v, candidates) }))
      .filter((x) => x.i >= 0)
      .sort((a, b) => a.i - b.i)[0];
    return { id: p.id, barcode: best?.v ?? null, sku: p.sku, unitSku: p.unitSku, product: p };
  });
  const winner = pickBestScanMatch(shims, candidates);
  const product = winner.product;

  const candidateIdx = Math.min(
    ...[winner.barcode, winner.sku, winner.unitSku]
      .map((v) => indexOf(v, candidates))
      .filter((i) => i >= 0),
  );
  const code = Number.isFinite(candidateIdx) ? candidates[candidateIdx] : candidates[0];

  const productRows: RowLike[] = rowsByProduct.get(product.id) ?? [];
  const ownRows: any[] = Array.isArray(product.barcodes) ? product.barcodes : [];
  const barcodes: ProductBarcodeView[] = ownRows.length
    ? barcodeRowsToView(ownRows)
    : productRows.length
      ? barcodeRowsToView(productRows as any)
      : synthesizeLegacyBarcodes(product);

  // The ONE shared derivation (server and clients agree): rows replace only the barcode column.
  // levelsForScannedCode itself ignores any row whose level is not BOX/UNIT.
  const levels = levelsForScannedCode(code, {
    ...product,
    barcodes: [...productRows, ...ownRows],
  });

  return {
    product: { ...product, barcodes },
    scanMatch: { code, levels },
    barcodes,
  };
}

/** SA-578 Q5 (i): >= 2 DISTINCT products on one row code is an invariant breach — ONE warn, count only. */
function warnOnRowCollision(rows: RowLike[], candidates: string[]): void {
  let worst = 0;
  for (const c of candidates) {
    const owners = new Set(rows.filter((r) => ci(r.code, c)).map((r) => r.productId));
    worst = Math.max(worst, owners.size);
  }
  if (worst >= 2) {
    logger.warn(`scan code collision: ${worst} distinct products share one barcode row code`);
  }
}
