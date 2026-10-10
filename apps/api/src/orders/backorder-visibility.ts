/**
 * OOS PR2 (SA-714 R3): the pure backorder-visibility rules. No Nest, no DB: `common/staff-only-fields.ts`
 * (the buyer order allowlist) and the catalog both import this file.
 */
export type BackorderVisibility = "show" | "hide";

export interface BuyerBackorderView {
  canBackorder: boolean;
  visibility: BackorderVisibility;
}

/** The truthful view: this buyer cannot backorder, nothing is masked. */
export const NO_BACKORDER_VIEW: BuyerBackorderView = { canBackorder: false, visibility: "show" };

/** Fail closed to today's truthful behaviour: ONLY the exact string "hide" hides. */
export function parseBackorderVisibility(raw: unknown): BackorderVisibility {
  return raw === "hide" ? "hide" : "show";
}

export interface StockTriple {
  inStock: boolean;
  stockStatus: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  stockLeft: number | null;
}

/**
 * Hide + this buyer can backorder: the item looks in stock and nothing about stock leaks. Any other
 * combination returns the truthful triple untouched (same object).
 */
export function maskStockForBuyer(stock: StockTriple, view: BuyerBackorderView): StockTriple {
  if (view.canBackorder && view.visibility === "hide") {
    return { inStock: true, stockStatus: "IN_STOCK", stockLeft: null };
  }
  return stock;
}

/**
 * The derived `backordered` flag of a buyer order line. Present ONLY under "show": under "hide" it is
 * `undefined`, so the key is absent from the JSON and nothing about backorders reaches the buyer.
 * `line.backorderPieces` is the persisted backorder marker (the migration lands with PR3); until that
 * column exists the field is absent on every line, so the flag is absent too (nothing to derive).
 */
export function derivedBackordered(
  visibility: BackorderVisibility,
  line: { backorderPieces?: unknown },
): boolean | undefined {
  if (visibility !== "show") return undefined;
  if (line.backorderPieces === undefined) return undefined; // no marker column on this row yet
  return Number(line.backorderPieces ?? 0) > 0;
}
