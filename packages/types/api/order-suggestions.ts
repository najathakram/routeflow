/**
 * "Usually buys" + "Order again" for staff New Order. Served by
 * `GET /customers/:customerId/order-suggestions` (OPERATOR / TENANT_ADMIN only, tenant-scoped).
 *
 * The payload carries WHAT the customer buys (products, quantities, units) and the product's CURRENT
 * catalog columns, never a price taken from history: every added line is priced today through the
 * order builder's normal add-line path (tier / special price), so a stale price cannot be reused.
 */

/** The catalog columns the order builder's add-line path reads, as they are NOW. */
export interface OrderSuggestionProduct {
  id: string;
  name: string;
  variantName: string | null;
  parentProductId: string | null;
  /** The parent's name for a variant (the order line reads "<Parent> - <Variant>"). */
  parent: { name: string } | null;
  unit: string;
  unitsPerBox: number | null;
  pricePerUnit: number;
  priceTier2: number;
  priceTier3: number;
  priceTier4: number;
  priceTier5: number;
  averageCost: number | null;
  category: string | null;
  trackedCategoryId: string | null;
  /** False = retired / deactivated: it can no longer be added to an order. */
  isActive: boolean;
}

export interface UsuallyBuysItem {
  productId: string;
  /** How many order lines carried this product in the last 90 days (non-cancelled orders). */
  orderLineCount: number;
}

/** One line of a past order: product + quantity + unit as ordered. No price. */
export interface RecentOrderLine {
  productId: string;
  /** Total pieces for a boxed line, else the count of the unit. */
  qty: number;
  boxes: number | null;
  pieces: number | null;
  /** The pack size the line was sold at (its sale-time snapshot); null = not a boxed line. */
  unitsPerBox: number | null;
  /** The non-pack unit the line sold by ("Carton"); null = the product's pack / plain unit. */
  unitLabel: string | null;
}

export interface RecentOrderSummary {
  id: string;
  orderNumber: string | null;
  /** ISO timestamp: the order's business date, else its creation time. */
  date: string;
  status: string;
  lines: RecentOrderLine[];
}

export interface OrderSuggestionsResponse {
  customerId: string;
  /** Top 8 active products by order-line count over the last 90 days, most bought first. */
  usuallyBuys: UsuallyBuysItem[];
  /** The last 5 non-cancelled orders, newest first. */
  recentOrders: RecentOrderSummary[];
  /** Every product referenced above, keyed by id (inactive ones included, flagged `isActive`). */
  products: Record<string, OrderSuggestionProduct>;
}
