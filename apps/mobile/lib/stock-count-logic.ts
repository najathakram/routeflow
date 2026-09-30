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
import { roundMoney } from "@routeflow/pricing";

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
  /**
   * PR-C durable-session display fields, all optional so `addScanToRows`'s
   * client-only-count return shape (tested exactly, 6 fields) never changes.
   * Populated by the screen from the resolved product / hydrated server line.
   */
  boxes?: number;
  pieces?: number;
  unitsPerBox?: number;
  /** 4dp cost-basis correction for this line (review screen), separate from
   * the variance-$ calc, which always uses `averageCost`. */
  unitCostOverride?: number;
  averageCost?: number;
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

// ─── Durable stock-count sessions (PR-C) ────────────────────────────────────
//
// The block above (client-only count → one-shot `POST /stock-count/commit`)
// stays exactly as it was. Below adds the pure logic for the DURABLE,
// server-side session (`/inventory/stock-counts*`): a session that can be
// paused, resumed on another device, and carries per-line attribution +
// review-time variance. `StockCountRow` (above) is reused as-is as the
// screen's local row shape — hydrated from server lines via
// `hydrateRowsFromSession`, with extra server-only display fields (boxes,
// pieces, unitsPerBox, averageCost, unitCostOverride) stitched on separately
// so `addScanToRows`'s tested return shape never changes.

export type StockCountSessionStatus = "OPEN" | "REVIEW" | "COMMITTED" | "DISCARDED";

export interface StockCountSessionSummary {
  id: string;
  tenantId?: string | null;
  name?: string | null;
  status: StockCountSessionStatus;
  startedById: string;
  startedAt: string;
  committedAt?: string | null;
  committedById?: string | null;
  discardedAt?: string | null;
  notes?: string | null;
  movementReference?: string | null;
  amendsSessionId?: string | null;
  startedBy?: { id: string; username: string } | null;
  committedBy?: { id: string; username: string } | null;
  _count?: { lines: number };
  /**
   * Server-computed net variance $ for the LIST endpoint only (the raw lines
   * aren't returned there — this scalar avoids an N+1 fetch per row). Same
   * delta rule as commit (REPLACE = counted − expected, ADD = counted),
   * valued at each product's current averageCost, rounded via roundMoney.
   * Optional so a session shape hydrated from the DETAIL endpoint (which
   * carries full `lines` instead) still type-checks without it.
   */
  netVarianceMoney?: number;
}

export interface StockCountLineProduct {
  id: string;
  name: string;
  sku?: string | null;
  unit?: string | null;
  unitsPerBox?: number | null;
  currentStock?: number | string | null;
  averageCost?: number | string | null;
}

export interface StockCountSessionLine {
  id: string;
  productId: string;
  mode: StockCountMode;
  countedQty: number | string;
  boxes?: number | null;
  pieces?: number | null;
  expectedQty: number | string;
  unitCostOverride?: number | string | null;
  countedById: string;
  updatedAt: string;
  product: StockCountLineProduct;
}

export interface StockCountSessionDetail extends StockCountSessionSummary {
  lines: StockCountSessionLine[];
}

export interface StartStockCountResult extends StockCountSessionSummary {
  /** A WARNING, not a lock — other sessions still OPEN/REVIEW when this one
   * was started. The caller offers "open it instead?"; nothing is blocked. */
  otherOpenSessions: Array<{
    id: string;
    name?: string | null;
    startedAt: string;
    startedById: string;
  }>;
}

/**
 * expected → counted variance for one server line, reusing the exact
 * mode-aware delta math `rowVariance` already locks (REPLACE = counted −
 * expected "on-hand IS this"; ADD = counted "add this to on-hand").
 * `expectedQty` is the server's on-hand SNAPSHOT from when the line was
 * first counted — the review screen's "expected" column.
 */
export function sessionLineVariance(
  line: Pick<StockCountSessionLine, "mode" | "countedQty" | "expectedQty">,
): { delta: number; after: number } {
  return rowVariance({
    mode: line.mode,
    counted: toNum(line.countedQty),
    stockBefore: toNum(line.expectedQty),
  });
}

/**
 * Variance in dollars at the product's CURRENT average cost — never the
 * line's `unitCostOverride` (that only sets the cost basis going forward at
 * commit; it does not change what the variance is worth today). Single
 * rounding path via `roundMoney`, mirroring the pricing.ts money discipline.
 */
export function sessionLineVarianceMoney(line: StockCountSessionLine): number {
  const { delta } = sessionLineVariance(line);
  return roundMoney(delta * toNum(line.product?.averageCost));
}

export interface GroupedSessionLines {
  /** Zero-variance — collapse under "N lines match" so attention goes to diffs. */
  matched: StockCountSessionLine[];
  /** Non-zero variance — shown expanded. */
  changed: StockCountSessionLine[];
}

export function groupSessionLinesByVariance(lines: StockCountSessionLine[]): GroupedSessionLines {
  const matched: StockCountSessionLine[] = [];
  const changed: StockCountSessionLine[] = [];
  for (const line of lines) {
    (sessionLineVariance(line).delta === 0 ? matched : changed).push(line);
  }
  return { matched, changed };
}

/** Net variance $ across a set of lines — the number the commit confirmation
 * and the post-commit toast both show. */
export function totalVarianceMoney(lines: StockCountSessionLine[]): number {
  return roundMoney(lines.reduce((sum, l) => sum + sessionLineVarianceMoney(l), 0));
}

export interface CommitSummary {
  changedCount: number;
  matchedCount: number;
  netVarianceMoney: number;
}

/** The commit confirmation's headline numbers — "Adjust N products (+$X /
 * −$Y at avg cost)". Uncounted products are never touched; the confirmation
 * copy stating that is a static string on the screen, not derived here. */
export function buildCommitSummary(lines: StockCountSessionLine[]): CommitSummary {
  const { matched, changed } = groupSessionLinesByVariance(lines);
  return {
    changedCount: changed.length,
    matchedCount: matched.length,
    netVarianceMoney: totalVarianceMoney(changed),
  };
}

/**
 * The COMPLETE absolute edit payload for a row's CURRENT local state — never
 * a partial diff. This is what every inline edit (qty stepper, mode toggle,
 * boxes/pieces, unit-cost override) sends to `autosave.queueEdit`: omitting
 * `countedQty` would make the server treat it as 0 (see
 * `UpsertStockCountLineDto` — `countedQty` defaults to 0 when absent and
 * `increment` isn't set), so every edit round-trips the row's full counted
 * state, not just the field that changed. Boxes/pieces win over the flat qty
 * when the row has a stored split, mirroring the server's own
 * boxes/pieces-wins-when-present rule.
 */
export function rowEditPatch(
  row: Pick<StockCountRow, "counted" | "boxes" | "pieces" | "unitCostOverride">,
): { countedQty?: number; boxes?: number; pieces?: number; unitCostOverride?: number | null } {
  const patch: {
    countedQty?: number;
    boxes?: number;
    pieces?: number;
    unitCostOverride?: number | null;
  } =
    row.boxes != null || row.pieces != null
      ? { boxes: Math.max(0, row.boxes ?? 0), pieces: Math.max(0, row.pieces ?? 0) }
      : { countedQty: Math.max(0, row.counted) };
  if (row.unitCostOverride !== undefined) patch.unitCostOverride = row.unitCostOverride;
  return patch;
}

export interface GroupedRows {
  matched: StockCountRow[];
  changed: StockCountRow[];
}

/** Row-shaped counterpart of `groupSessionLinesByVariance`, for the live scan
 * / review screen's local state (server lines only refresh periodically). */
export function groupRowsByVariance(rows: StockCountRow[]): GroupedRows {
  const matched: StockCountRow[] = [];
  const changed: StockCountRow[] = [];
  for (const r of rows) {
    (rowVariance(r).delta === 0 ? matched : changed).push(r);
  }
  return { matched, changed };
}

/** Variance $ for one row at ITS `averageCost` snapshot — same rule as
 * `sessionLineVarianceMoney`: never the row's own `unitCostOverride`. */
export function rowVarianceMoney(
  row: Pick<StockCountRow, "mode" | "counted" | "stockBefore" | "averageCost">,
): number {
  const { delta } = rowVariance(row);
  return roundMoney(delta * (row.averageCost ?? 0));
}

export function totalRowVarianceMoney(rows: StockCountRow[]): number {
  return roundMoney(rows.reduce((sum, r) => sum + rowVarianceMoney(r), 0));
}

export interface RowCommitSummary {
  changedCount: number;
  matchedCount: number;
  netVarianceMoney: number;
}

/** Row-shaped counterpart of `buildCommitSummary` — the review screen's
 * live headline as the operator edits, before anything round-trips. */
export function buildRowCommitSummary(rows: StockCountRow[]): RowCommitSummary {
  const { matched, changed } = groupRowsByVariance(rows);
  return {
    changedCount: changed.length,
    matchedCount: matched.length,
    netVarianceMoney: totalRowVarianceMoney(changed),
  };
}

/**
 * Hydrate the screen's local rows from a resumed/reopened server session.
 * `stockBefore` is the server's `expectedQty` snapshot (NOT live currentStock)
 * — resuming must keep comparing against what was expected when the count
 * started, not silently re-snapshot to today's stock.
 */
export function hydrateRowsFromSession(lines: StockCountSessionLine[]): StockCountRow[] {
  return lines.map((l) => ({
    productId: l.productId,
    name: l.product.name,
    sku: l.product.sku ?? undefined,
    unit: l.product.unit ?? undefined,
    stockBefore: toNum(l.expectedQty),
    counted: toNum(l.countedQty),
    mode: l.mode,
    boxes: l.boxes ?? undefined,
    pieces: l.pieces ?? undefined,
    unitsPerBox: l.product.unitsPerBox ?? undefined,
    unitCostOverride: l.unitCostOverride != null ? toNum(l.unitCostOverride) : undefined,
    averageCost: l.product.averageCost != null ? toNum(l.product.averageCost) : undefined,
  }));
}
