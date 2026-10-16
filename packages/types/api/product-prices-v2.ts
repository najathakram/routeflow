// Units v2 price writes and customer price reads (flag.units_prices_v2). SPRINT-CONTRACT K0, 2026-10-16.
//
// Shapes follow @routeflow/pricing exactly (this package never imports it, so they are structural copies):
//   - a cell is (ref, tier): `ref` = "pack" | "base" | a ProductUnit id (SA-796 R-3, DB-enforced), never "label:...";
//     `tier` 1 = Retail, 2..5 = the price tiers (PRICE_TIERS / PriceTier);
//   - money is a number in dollars, rounded to cents (roundMoney), like ProductPriceGridCellDto.value;
//   - `value: null` = clear the set price (Auto again), as CellPatch.to.
// Rulings: SA-796 R-1 (revision + value compare-and-set, 409 LADDER_REVISION_STALE), SA-799 (one write, one audit
// row, priceRevision + 1, Undo = one inverse write under the same precondition), SA-798/798a (customer moves are opt-in).

import type { API_ERROR_CODES } from "./error-codes";
import type { ProductPriceGridDto } from "./products";

/** PriceTier of @routeflow/pricing. */
export type PriceTierNumber = 1 | 2 | 3 | 4 | 5;

/** One product cell to write: pricing `CellPatch` exactly. The edited cells and every TICKED tier offer. */
export interface PriceCellPatch {
  ref: string;
  /** 1 = Retail, 2..5 = tiers (PriceTier). */
  tier: number;
  /** A positive price, or null = Auto (clear the set price). */
  to: number | null;
}

/** A follower's Keep (pricing `Pin`): the Auto cell is pinned as SET at the value it shows now (P7). */
export interface PriceCellKeep {
  ref: string;
  tier: number;
  value: number;
}

/**
 * One customer cell (CustomerUnitPrice, keyed by customerId + productId + unitRef). Covers three writes:
 *   - a ticked SA-798 customer move: `from` = the set price read, `to` = the new one (CustomerMoveOffer.moves);
 *   - a customer Keep: `from: null` (no row expected), `to` = the price it shows now;
 *   - an Undo row: `to: null` deletes the row.
 * `from` is the per-customer-cell compare-and-set (SA-799 b): the row must hold exactly `from` (or be absent when null),
 * else 409 LADDER_REVISION_STALE and nothing is written. `tier` is the customer's tier, carried for the audit and the
 * preview only; it is not part of the row key.
 */
export interface CustomerPriceMove {
  customerId: string;
  ref: string;
  tier: number;
  from: number | null;
  to: number | null;
}

/**
 * POST /products/:productId/prices: everything one Save commits, in ONE transaction (SA-799 b). Aligned to K3's draft
 * payload `{ productId, patches, orderUnit, keeps }`.
 */
export interface SavePricesRequest {
  /** The product's priceRevision the draft was built on (ProductPriceGridDto.revision). R-1 CAS -> 409 LADDER_REVISION_STALE. */
  expectedRevision: number;
  /**
   * REQUIRED (lead final ruling 2026-10-16, SA-796 R-1): ProductPriceGridDto.priceState the draft was built on, the value
   * compare-and-set over the price-bearing state (~20 legacy writers skip the revision bump, so revision alone is not a
   * value check). A client whose grid has no priceState cannot save.
   */
  expectedPriceState: string;
  /** At least one of patches / keeps / customerMoves is non-empty. A (ref, tier) appears at most once across patches+keeps. */
  patches: PriceCellPatch[];
  keeps?: PriceCellKeep[];
  /** Ticked SA-798 moves and customer Keeps. */
  customerMoves?: CustomerPriceMove[];
  /**
   * The product order unit picked in the draft (V06). Typed now so the draft needs no reshape later; U-1 owns its rules.
   * Until U-1 lands the server refuses any value that differs from the current one with the existing 409
   * PRICING_RULES_NOT_READY (assertOrderUnitSwitchAllowed), nothing written. Omit or send the current ref otherwise.
   */
  orderUnit?: string;
}

/** What Undo would write: the inverse of a save (applyCellPatches' `undo`, plus each customer move reversed). */
export interface SavePricesUndo {
  patches: PriceCellPatch[];
  customerMoves: CustomerPriceMove[];
}

/** Response of a save AND of an undo. */
export interface SavePricesResponse {
  /** priceRevision after the write (the old one + 1). */
  revision: number;
  /** The one audit row of this write; Undo names it. */
  auditId: string;
  /** Optional: the inverse write, for Undo's preview when anything changed since (SA-799 b). */
  undo?: SavePricesUndo;
  /** The fresh grid (same read model as GET price-grid), so the client never refetches after a save. */
  grid: ProductPriceGridDto;
}

/** POST /products/:productId/prices/undo. Precondition = the CURRENT grid's revision and priceState, as a save. */
export interface UndoPricesRequest {
  auditId: string;
  expectedRevision: number;
  /** REQUIRED, as on a save. */
  expectedPriceState: string;
}

/** The 409 body of LADDER_REVISION_STALE (save and undo). Nothing was written; reload the grid. */
export interface LadderRevisionStaleBody {
  code: typeof API_ERROR_CODES.LADDER_REVISION_STALE;
  message: string;
  /** The product's priceRevision now. */
  revision: number;
}

/** The 400 body of PRICE_EDIT_INVALID (POST prices): the pricing core's refusals (validateSetPrice, the anchor's Retail). */
export interface PriceEditInvalidBody {
  code: typeof API_ERROR_CODES.PRICE_EDIT_INVALID;
  message: string;
  problems: string[];
}

/**
 * GET /products/:productId/customer-prices: the customers with at least one CustomerUnitPrice row for this product,
 * in the shape the planners take (pricing CustomerPricingWithId), for planPriceChange's `customers` and the
 * "Also update" customer section. Capped at 500, newest first; `truncated` says more exist.
 */
export interface ProductCustomerPricingDto {
  customerId: string;
  name: string;
  /** customerTierFor(customerProductTier, customerTier). */
  tier: PriceTierNumber;
  /** The customer's own order unit for this product, or null. */
  orderUnit: string | null;
  /** Typed prices by unit ref. */
  set: Record<string, number>;
}
export interface ProductCustomerPricesResponse {
  productId: string;
  revision: number;
  customers: ProductCustomerPricingDto[];
  truncated: boolean;
}

/** resolveCustomerUnitPrice's `source`. */
export type CustomerUnitPriceSource = "customer" | "customer-shape" | "tier" | "list";

/** One unit row of the customer view: what this customer pays vs the list (Retail) and their tier's price. */
export interface CustomerUnitPriceRowDto {
  /** ProductPriceGridRowDto fields, unchanged. */
  ref: string;
  label: string;
  factor: number;
  kind: "pack" | "base" | "unit";
  code: string | null;
  /** resolveCustomerUnitPrice(...).price. */
  price: number;
  /** The Retail (tier 1) cell of the grid. */
  listPrice: number;
  /** The customer's tier cell of the grid (= listPrice for a Retail customer). */
  tierPrice: number;
  source: CustomerUnitPriceSource;
}

/** One product in the customer view: its unit rows priced for this customer. */
export interface CustomerProductUnitPricesDto {
  productId: string;
  productName: string;
  /** The customer's own order unit for this product, or null (the tier's anchor applies). */
  orderUnit: string | null;
  revision: number;
  rows: CustomerUnitPriceRowDto[];
}

/**
 * GET /customers/:customerId/unit-prices[?productId=] (K6, V10/V11). One entry per product; `?productId=` narrows to
 * one (the product-page Customer view). Without it: the products this customer has a CustomerUnitPrice row for.
 */
export interface CustomerUnitPricesResponse {
  customerId: string;
  customerName: string;
  tier: PriceTierNumber;
  products: CustomerProductUnitPricesDto[];
}
