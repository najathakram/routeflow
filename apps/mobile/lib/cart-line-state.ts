import type { DraftLinePriceSource } from "@routeflow/types";

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
  /** M1 `ProductBarcode` rows (additive on the list/detail payload) — the local scan fast path reads them. */
  barcodes?: Array<{ code: string; level: "BOX" | "UNIT" }> | null;
  /** #2717 M4a-1: on a scan-lookup response, which code hit and the levels it has (server-resolved). */
  scanMatch?: { code: string; levels: Array<"BOX" | "UNIT"> } | null;
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
  /** #2696(c): why `unitPrice` moves off a SPECIAL (tier) price — the server requires one there,
   *  and a special line's override is only billed with it (`lineUnitFor`). */
  overrideReason?: string;
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
  /** #2784 UI-only: the qty a NEW picker-tap line was created with. The default unit applies only while `qty` still equals it (any qty edit ends the default-start; a boxed qty is total pieces, so a fixed `qty <= 1` guard would never match) and no operator price is typed. UnitPickerRow applies it once. */
  startOnDefaultUnit?: number;
  /** #2865 case c UI-only: how many default-start taps this PENDING line recorded (N taps = N of the default unit on resolve). */
  pendingTaps?: number;
  /** #2865 (F3): the scan code that CREATED this pending line; a repeat scan of the same label is a default-unit tap. */
  pendingCode?: string;
  /** SA-626d: the remembered PACK price stashed while the line sells by a unit (re-applied on an explicit pack pick). */
  packUnitPrice?: number;
  /**
   * units_v1: the chosen unit's own resolved tier price — the comparison base `unitPrice`
   * diverging from means a genuine operator override, in place of `catalogPrice` (the PACK's
   * price, which a Case's price will almost always differ from even with NO override typed).
   * Unset while `unitLabel` is unset (the pack uses `catalogPrice` directly, as before).
   */
  unitBasePrice?: number;
  /**
   * units_v1 (SA-085f HIGH #3): pieces per ONE of `unitLabel` (`UnitOption.factorToBase`) —
   * the basis the margin/floor hint multiplies cost by, in place of the PACK's `unitsPerBox`
   * (a Case's cost is cost-per-piece × the Case's OWN factor, which for a level like "Pallet"
   * spanning several packs is not `unitsPerBox` at all). Unset while `unitLabel` is unset.
   */
  unitFactor?: number;
  /**
   * B755: where `unitPrice` came from — a remembered price-history pre-fill (`addOne`), or a
   * genuine operator override (`setLinePrice`). Draft-only: never read by `submitOrder`, and
   * only meaningful alongside a MANUAL `priceType` on the parked line — a "history" price is
   * never pinned across a resume, an "operator" one always is. Undefined on a line with no
   * override at all (nothing to distinguish), and on any line predating this field.
   */
  priceSource?: DraftLinePriceSource;
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

/**
 * Conditional remembered-price pre-fill (mirrors web CreateOrderModal): only a genuine one-time DISCOUNT (below the
 * tier price) or UPSELL (above list) pre-fills, never over a SPECIAL tier price (already the customer's permanent
 * price). An equal-to-tier remembered price does not pre-fill (strict < >).
 */
export function rememberedPricePrefill(
  hist: { lastPrice: number } | null | undefined,
  listPrice: number,
  tierPrice: number,
  isSpecial: boolean,
): number | undefined {
  if (isSpecial || hist == null) return undefined;
  return hist.lastPrice < tierPrice || hist.lastPrice > listPrice ? hist.lastPrice : undefined;
}
