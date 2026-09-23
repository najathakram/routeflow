/**
 * Shared by NewOrderScreen.tsx and its CartRow — split out so CartRow can move to its own
 * file (`components/CartRow.tsx`) without a circular import back to NewOrderScreen.tsx.
 * Moved verbatim, no logic changes.
 */

export type Product = {
  id: string;
  name: string;
  sku?: string | null;
  /** Retail-unit code — scannable, so the local scan fast path must see it. */
  unitSku?: string | null;
  barcode?: string | null;
  unit?: string;
  pricePerUnit: number | string;
  // Tier price columns (Decimal, serialised as strings; 0 ⇒ inherit list). The
  // /products payload already carries these — getTierPrice coerces + guards.
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
  category?: string | null;
  /** Regulated category this product belongs to (drives the license-guard remove-line exit). */
  trackedCategoryId?: string | null;
  /** Per-piece average cost — drives the live margin hint + the cost eye (web uses
   *  averageCost, not standardCost). Operator/driver endpoints return it; buyers
   *  never get this screen and their endpoints strip cost fields. */
  averageCost?: number | string | null;
  standardCost?: number | string | null;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  parent?: { id: string; name: string } | null;
  /**
   * `GET /products/:id` (draft-resume hydration) and the barcode ladder both
   * return an archived product, unlike the catalog list. Such a line is KEPT
   * on resume — it is still orderable server-side — and the cart row flags it
   * as Archived rather than deleting the operator's scanned work (R5/B195).
   */
  isActive?: boolean | null;
};

export type LineState = {
  qty: number;
  boxes?: number;
  pieces?: number;
  /**
   * Optional one-time price override (the "discounted price"). When unset the
   * catalog price is used. For boxed products this is the BOX price, matching
   * the catalog price unit; computeLineSubtotal prorates loose pieces.
   */
  unitPrice?: number;
  /** Optional per-line note — carried onto the invoice line (buyer-visible). */
  note?: string;
  /** Note input expanded for this row (note text survives collapse). */
  noteOpen?: boolean;
  /** UI-only qty entry mode for a case-packed line. NEVER submitted — the
   *  payload always carries {qty, boxes, pieces} and the per-case unitPrice. */
  sellBy?: "case" | "unit";
  /**
   * units_v1: the unit this line is sold by ("Case"…), picked via `UnitPickerRow`. When set,
   * `qty` is the unit COUNT (never expanded pieces) and boxes/pieces stay unset — see
   * `submitOrder`'s catalogPayload builder.
   */
  unitLabel?: string | null;
  /**
   * units_v1: the chosen unit's own resolved tier price — the comparison base `unitPrice`
   * diverging from means a genuine operator override, in place of `catalogPrice` (the PACK's
   * price, which a Case's price will almost always differ from even with NO override typed).
   * Unset while `unitLabel` is unset (the pack uses `catalogPrice` directly, as before).
   */
  unitBasePrice?: number;
};

export function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** The effective per-unit price for a line: the override, else the resolved base
 *  (tier) price. Callers pass the customer's effective tier price as `basePrice`. */
export function effectiveUnitPrice(line: LineState | undefined, basePrice: number): number {
  return line?.unitPrice != null ? line.unitPrice : basePrice;
}
