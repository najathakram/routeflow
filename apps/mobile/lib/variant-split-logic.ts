/**
 * Pure logic for the variant-split sheet (`components/VariantSplitSheet.tsx`):
 * remaining-pool math, live per-row clamping, and building the
 * `POST /inventory/variant-assign` payload. No React/RN imports — this stays
 * node-testable (`__tests__/variant-split-logic.test.ts`).
 *
 * Mirrors the server contract documented in the PR-D plan (WP1): a row either
 * targets an existing variant (`productId`) or creates one inline
 * (`newVariantName`), and its qty is expressed either as a plain `qty` or, for
 * a boxed parent, as `boxes`/`pieces` — never both at once on the wire.
 */
import { normalizeBoxesPieces, roundUnitCost } from "./pricing";

export interface SplitRow {
  /** Stable client-side row id — an existing variant's productId, or a generated key for a new-variant row. */
  key: string;
  /** Existing variant this row assigns to. Omitted for a brand-new variant row. */
  productId?: string;
  /** Name for a brand-new variant (ignored once `productId` is set). */
  newVariantName?: string;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  /**
   * RAW TEXT of the per-row cost override, exactly as typed — mirrors web's
   * `RowState.cost`. It must stay a string: a controlled input backed by a
   * number round-trips through `Number()` on every keystroke, which eats the
   * decimal point ("2." -> 2 -> "2") and makes a cost like 2.75 untypable.
   * Parsed once, at submit, by `parseCostText`. Blank/invalid = inherit the
   * parent's average cost server-side.
   */
  unitCostText?: string | null;
}

/**
 * Raw cost text -> a submittable 4dp unit cost, or null when the row should
 * just inherit the parent's average. Blank, non-numeric and negative input all
 * resolve to null, so a half-typed or pasted value never reaches the wire.
 */
export function parseCostText(text: string | null | undefined): number | null {
  const raw = (text ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundUnitCost(n);
}

/**
 * Base-unit quantity a row currently resolves to. For a boxed parent with a
 * boxes/pieces split present, that split wins over the raw `qty` — mirrors
 * the server's `normalizeBoxesPieces` precedence so the sheet never disagrees
 * with what will actually be submitted.
 */
export function resolvedRowQty(
  row: Pick<SplitRow, "qty" | "boxes" | "pieces">,
  unitsPerBox?: number | null,
): number {
  const upb = Number(unitsPerBox ?? 0);
  if (upb > 1 && (row.boxes != null || row.pieces != null)) {
    return normalizeBoxesPieces({ boxes: row.boxes, pieces: row.pieces, unitsPerBox }).qty;
  }
  return Math.max(0, Number(row.qty) || 0);
}

/** How much of `pool` is still unassigned across every row. Never negative. */
export function remainingPool(pool: number, rows: SplitRow[], unitsPerBox?: number | null): number {
  const assigned = rows.reduce((sum, r) => sum + resolvedRowQty(r, unitsPerBox), 0);
  return Math.max(0, (Number(pool) || 0) - assigned);
}

/**
 * Clamp a desired base-unit qty so the pool is never over-committed, given
 * what every OTHER row already holds. Floors at 0, ceilings at what's left
 * after the other rows.
 */
export function clampToAvailable(desiredQty: number, pool: number, otherRowsQty: number): number {
  const available = Math.max(0, (Number(pool) || 0) - (Number(otherRowsQty) || 0));
  const desired = Math.max(0, Number(desiredQty) || 0);
  return Math.min(desired, available);
}

/**
 * Apply a qty/boxes/pieces edit to one row and clamp it live against the pool
 * and every other row's current assignment. A boxed edit is clamped as a
 * TOTAL (via `normalizeBoxesPieces`) then re-split, so over-typing (e.g.
 * bumping Cases past what's left) rolls back to a consistent boxes/pieces
 * pair instead of leaving the two fields disagreeing.
 */
export function applyRowQtyChange(
  rows: SplitRow[],
  key: string,
  patch: Partial<Pick<SplitRow, "qty" | "boxes" | "pieces">>,
  pool: number,
  unitsPerBox?: number | null,
): SplitRow[] {
  const otherRowsQty = rows
    .filter((r) => r.key !== key)
    .reduce((sum, r) => sum + resolvedRowQty(r, unitsPerBox), 0);
  const upb = Number(unitsPerBox ?? 0);
  return rows.map((r) => {
    if (r.key !== key) return r;
    const merged = { ...r, ...patch };
    if (upb > 1 && (merged.boxes != null || merged.pieces != null)) {
      const desiredTotal = resolvedRowQty(merged, unitsPerBox);
      const clampedTotal = clampToAvailable(desiredTotal, pool, otherRowsQty);
      const split = normalizeBoxesPieces({ qty: clampedTotal, unitsPerBox });
      return { ...merged, boxes: split.boxes, pieces: split.pieces, qty: split.qty };
    }
    return { ...merged, qty: clampToAvailable(Number(merged.qty) || 0, pool, otherRowsQty) };
  });
}

// ─── Request payload ───────────────────────────────────────────────────────

export interface VariantAssignmentPayload {
  productId?: string;
  newVariant?: { name: string };
  qty?: number;
  boxes?: number;
  pieces?: number;
  unitCostOverride?: number;
}

export interface VariantAssignRequest {
  parentProductId: string;
  assignments: VariantAssignmentPayload[];
  notes?: string;
}

/**
 * Build the `POST /inventory/variant-assign` body from the sheet's rows.
 * Drops any row that resolves to 0 qty and any new-variant row left unnamed —
 * neither is submittable. Returns null when nothing survives (submit stays
 * disabled in that case).
 */
export function buildVariantAssignPayload(
  parentProductId: string,
  rows: SplitRow[],
  unitsPerBox: number | null | undefined,
  notes?: string,
): VariantAssignRequest | null {
  const upb = Number(unitsPerBox ?? 0);
  const assignments: VariantAssignmentPayload[] = [];
  for (const row of rows) {
    const qty = resolvedRowQty(row, unitsPerBox);
    if (qty <= 0) continue;
    const target: VariantAssignmentPayload = {};
    if (row.productId) {
      target.productId = row.productId;
    } else {
      const name = (row.newVariantName ?? "").trim();
      if (!name) continue; // no existing target and no name for a new one — can't submit
      target.newVariant = { name };
    }
    if (upb > 1 && (row.boxes != null || row.pieces != null)) {
      const split = normalizeBoxesPieces({ boxes: row.boxes, pieces: row.pieces, unitsPerBox });
      target.boxes = split.boxes ?? 0;
      target.pieces = split.pieces ?? 0;
    } else {
      target.qty = qty;
    }
    const unitCostOverride = parseCostText(row.unitCostText);
    if (unitCostOverride != null) {
      target.unitCostOverride = unitCostOverride;
    }
    assignments.push(target);
  }
  if (assignments.length === 0) return null;
  const trimmedNotes = notes?.trim();
  return { parentProductId, assignments, ...(trimmedNotes ? { notes: trimmedNotes } : {}) };
}
