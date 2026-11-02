// SA-1086: `GET /orders/stock-availability` (apps/api/src/orders/stock-availability.ts). A read-only
// response DTO the order screens' live stock note shares with the API: never redeclare it locally.

/** What is left of one product, in PIECES (`Product.currentStock`) — never cases. */
export interface StockAvailabilityItem {
  productId: string;
  availablePieces: number;
}

export interface StockAvailability {
  /** The SAME boolean the save path resolves: true = an over-stock line is accepted, false = refused. */
  allowOversell: boolean;
  /** One entry per product the tenant can see; a recipe product is left out (no honest number). */
  items: StockAvailabilityItem[];
}
