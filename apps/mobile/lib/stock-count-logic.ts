/**
 * Pure logic for the scan-driven stock-count sheet (mirrors web's StockCountTab +
 * stock-count-storage). A count is held client-side; on Commit the rows become a
 * single `POST /inventory/stock-count/commit` (the server skips zero-delta lines
 * and posts the rest as ADJUSTMENT movements grouped by sessionId). Screen-free so
 * apps/mobile/__tests__/*.test.ts (node env) can lock the variance + payload math.
 *
 * Mode per row: REPLACE = "set on-hand TO the counted number" (server delta =
 * counted − before); ADD = "add the counted number to on-hand" (delta = counted).
 */

export type StockCountMode = "REPLACE" | "ADD";

export interface CountedProduct {
  id: string;
  name: string;
  sku?: string | null;
  unit?: string | null;
  currentStock?: number | string | null;
}

export interface StockCountRow {
  productId: string;
  name: string;
  sku?: string;
  unit?: string;
  /** On-hand at the moment the row was first added (the "before"). */
  stockBefore: number;
  /** REPLACE: absolute target on-hand. ADD: amount to add. Built up per scan. */
  counted: number;
  mode: StockCountMode;
}

export interface CommitStockCountItem {
  productId: string;
  quantity: number;
  mode: StockCountMode;
}

function toNum(v: number | string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Add a scanned/picked product: increment its existing row's `counted` by
 * `qtyPerScan`, else append a fresh row seeded from the product's current stock.
 */
export function addScanToRows(
  rows: StockCountRow[],
  product: CountedProduct,
  qtyPerScan: number,
  defaultMode: StockCountMode,
): StockCountRow[] {
  const idx = rows.findIndex((r) => r.productId === product.id);
  if (idx >= 0) {
    const next = rows.slice();
    next[idx] = { ...next[idx], counted: next[idx].counted + qtyPerScan };
    return next;
  }
  return [
    ...rows,
    {
      productId: product.id,
      name: product.name,
      sku: product.sku ?? undefined,
      unit: product.unit ?? undefined,
      stockBefore: toNum(product.currentStock),
      counted: qtyPerScan,
      mode: defaultMode,
    },
  ];
}

/** The delta the commit will apply and the resulting on-hand. */
export function rowVariance(row: Pick<StockCountRow, "mode" | "counted" | "stockBefore">): {
  delta: number;
  after: number;
} {
  const delta = row.mode === "REPLACE" ? row.counted - row.stockBefore : row.counted;
  return { delta, after: row.stockBefore + delta };
}

/**
 * Map rows → commit items. All rows are sent (never filter to empty — the DTO
 * requires ≥1 item); the server skips zero-delta lines itself.
 */
export function buildCommitItems(rows: StockCountRow[]): CommitStockCountItem[] {
  return rows.map((r) => ({
    productId: r.productId,
    quantity: Math.max(0, r.counted),
    mode: r.mode,
  }));
}

/** How many rows will actually move stock (non-zero delta) — for the summary/guard. */
export function changedRowCount(rows: StockCountRow[]): number {
  return rows.filter((r) => rowVariance(r).delta !== 0).length;
}

/**
 * RFC-4122 v4 UUID — the count's grouping id (the server @IsUUID-validates it and
 * uses it only to tag the movements' `reference`, so a non-crypto source is fine).
 */
export function newSessionId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
