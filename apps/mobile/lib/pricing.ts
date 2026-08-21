interface TierPriceable {
  pricePerUnit?: number | string | null;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
}

/**
 * Mobile mirror of `apps/api/src/utils/pricing.ts#getTierPrice` — keep in sync.
 * The `|| fallback` guard matters: tier columns default to 0 in the DB, and an
 * unset (0) tier means "inherit the list price", never "$0.00". Behavior locked
 * by `apps/api/src/utils/pricing.spec.ts` + `apps/mobile/__tests__/pricing.test.ts`.
 */
export function getTierPrice(product: TierPriceable, tier: number): number {
  const fallback = Number(product.pricePerUnit) || 0;
  switch (tier) {
    case 1:
      return fallback;
    case 2:
      return Number(product.priceTier2 ?? product.pricePerUnit) || fallback;
    case 3:
      return Number(product.priceTier3 ?? product.pricePerUnit) || fallback;
    case 4:
      return Number(product.priceTier4 ?? product.pricePerUnit) || fallback;
    case 5:
      return Number(product.priceTier5 ?? product.pricePerUnit) || fallback;
    default:
      return fallback;
  }
}

/** The five tier price columns in ladder order. Index 0 (`pricePerUnit`) is Tier 1 / list. */
export type TierField = "pricePerUnit" | "priceTier2" | "priceTier3" | "priceTier4" | "priceTier5";
export const TIER_FIELDS: readonly TierField[] = [
  "pricePerUnit",
  "priceTier2",
  "priceTier3",
  "priceTier4",
  "priceTier5",
];

/**
 * Tier-edit cascade: COMMITTING a new price on tier N copies it down to every lower tier
 * (N+1..5) unconditionally, so an operator can walk the ladder setting each break once.
 * Returns ONLY the cascaded fields, as 2-dp decimal strings (ready for a form draft or a
 * PATCH payload); the edited field itself stays the caller's own write.
 *
 * Returns {} for tier 5 (nothing below it), negative, or non-finite input.
 *
 * NOT used for Tier 1 / `pricePerUnit` — the list price keeps its existing "smart" behavior
 * (only tiers that still matched the OLD list price follow it), which preserves a
 * deliberately customized ladder when the list price is re-priced.
 *
 * Committing 0 cascades an explicit "0.00", which under getTierPrice's `|| fallback` guard
 * means "these tiers inherit the list price again" — that is intended.
 *
 * Change detection ("the user focused and typed but did not actually change anything")
 * belongs to the caller's commit mechanism, never to this function.
 */
export function cascadeTierPrices(
  field: TierField,
  value: number,
): Partial<Record<TierField, string>> {
  const idx = TIER_FIELDS.indexOf(field);
  if (idx < 1 || !Number.isFinite(value) || value < 0) return {};
  const v = (Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100).toFixed(2);
  const patch: Partial<Record<TierField, string>> = {};
  for (let i = idx + 1; i < TIER_FIELDS.length; i++) patch[TIER_FIELDS[i]] = v;
  return patch;
}

/**
 * Mobile mirror of `apps/api/src/common/pricing.ts#computeLineSubtotal` and
 * `apps/web/lib/pricing.ts#computeLineSubtotal`. Keep these three in sync —
 * the server is authoritative on what gets stored, but the client uses this
 * for live "Line total" + cart totals so the operator sees the same number
 * the server will compute on submit.
 *
 * For boxed products (`unitsPerBox > 1`) `unitPrice` is the BOX price.
 * Loose pieces below a full box are prorated as `unitPrice / unitsPerBox`.
 * Non-boxed products keep the per-piece semantics unchanged.
 */
export interface LineSubtotalInput {
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /**
   * Whole SELLING units made free by a BUY_N_GET_M promo — subtracted before
   * pricing so the saving is EXACT, never a rounded net-unit-price. Clamped so
   * the line can never go negative. Default 0: existing call sites unaffected.
   */
  freeUnits?: number;
}

/**
 * Round a monetary amount to cents — single rounding policy mirrored from
 * `apps/api/src/common/pricing.ts#roundMoney`. Keep all three in sync.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

/**
 * Round a per-unit cost to 4 decimal places — the client mirror of
 * `COST_DP = 4` in `apps/api/src/inventory/costing.ts` (deliberately NOT
 * that codebase's own `apps/api/src/common/pricing.ts`, which only ever
 * rounds to cents via `roundMoney`). A per-piece cost derived by dividing a
 * case cost by piecesPerBox needs the extra precision so scanned-line
 * boxes<->pieces conversions (`scan-line-units.ts#toBillLine`) round-trip
 * exactly; `roundMoney` still owns the final 2dp money total. Purely
 * additive — does not alter `roundMoney` or any other existing helper.
 */
export function roundUnitCost(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 10000)) / 10000;
}

export interface NormalizedQty {
  boxes: number | null;
  pieces: number | null;
  qty: number;
}

/**
 * Force INTEGER boxes/pieces/qty and roll loose pieces >= unitsPerBox into boxes.
 * Mirror of `apps/api/src/common/pricing.ts#normalizeBoxesPieces`.
 */
export function normalizeBoxesPieces(input: {
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  unitsPerBox?: number | null;
}): NormalizedQty {
  const upb = Math.trunc(Number(input.unitsPerBox ?? 0));
  if (upb > 1) {
    const splitProvided = input.boxes != null || input.pieces != null;
    const totalPieces = splitProvided
      ? Math.trunc(Number(input.boxes ?? 0)) * upb + Math.trunc(Number(input.pieces ?? 0))
      : Math.trunc(Number(input.qty ?? 0));
    const safeTotal = Math.max(0, totalPieces);
    return { boxes: Math.floor(safeTotal / upb), pieces: safeTotal % upb, qty: safeTotal };
  }
  return { boxes: null, pieces: null, qty: Math.max(0, Math.trunc(Number(input.qty ?? 0))) };
}

export function computeLineSubtotal({
  unitPrice,
  qty,
  boxes,
  pieces,
  unitsPerBox,
  freeUnits = 0,
}: LineSubtotalInput): number {
  const free = Math.max(0, Math.trunc(Number(freeUnits) || 0));
  const upb = Number(unitsPerBox ?? 0);
  const hasBoxPackaging = upb > 1;
  const boxesPiecesProvided = boxes != null || pieces != null;

  if (hasBoxPackaging && boxesPiecesProvided) {
    const b = Number(boxes ?? 0);
    const p = Number(pieces ?? 0);
    const boxEquivalent = Math.max(0, b - free) + p / upb;
    return roundMoney(unitPrice * boxEquivalent);
  }
  return roundMoney(unitPrice * Math.max(0, qty - free));
}

/**
 * DISPLAY-ONLY derived per-unit price for a case-packed product: case price ÷ units-per-case,
 * rounded to cents. Returns null when the product is sold as single units (unitsPerBox
 * null/0/1) or the input is not a finite number.
 *
 * NEVER persist this, never submit it, never feed it back into line math. Lines always carry
 * the CASE price plus boxes/pieces and are priced by computeLineSubtotal, whose proration is
 * computed before rounding — so `perUnitPrice(p, upb) * pieces` can differ from the true line
 * subtotal by a cent. computeLineSubtotal is authoritative; this is a shopper-facing hint.
 */
export function perUnitPrice(unitPrice: number, unitsPerBox?: number | null): number | null {
  const upb = Number(unitsPerBox ?? 0);
  const price = Number(unitPrice);
  if (!(upb > 1) || !Number.isFinite(price)) return null;
  return roundMoney(price / upb);
}

/**
 * Prorate an order line's STORED subtotal by delivered-vs-ordered qty.
 * Mirrors the server's per-batch invoice line total EXACTLY —
 * apps/api/src/orders/orders.service.ts:3321
 *   `subtotal = roundMoney((li.storedSubtotal * li.qty) / li.orderQty)`
 * — proportional-of-stored-subtotal, NOT a fresh qty×unitPrice recompute, so
 * boxed/overridden/promo lines prorate correctly. Returns 0 when there's no
 * stored subtotal yet or nothing was delivered.
 */
export function prorateLineSubtotal(
  storedSubtotal: number | null | undefined,
  deliveredQty: number,
  orderQty: number,
): number {
  if (storedSubtotal == null || orderQty <= 0 || deliveredQty <= 0) return 0;
  return roundMoney((storedSubtotal * deliveredQty) / orderQty);
}

/**
 * Effective qty in pieces, derived from boxes/pieces when present, otherwise
 * the explicit `qty` field. Mirrors the server-side recomputation in
 * `apps/api/src/orders/orders.service.ts`.
 */
export function effectiveQty(
  line: { qty?: number; boxes?: number | null; pieces?: number | null },
  unitsPerBox?: number | null,
): number {
  if (line.boxes != null || line.pieces != null) {
    const upb = Number(unitsPerBox ?? 0);
    return (line.boxes ?? 0) * upb + (line.pieces ?? 0);
  }
  return line.qty ?? 0;
}

// ─── Margin: the "negotiation floor" (pos-cost-roles-spec §1) ─────────────────
// Mirror of `apps/api/src/common/pricing.ts`. `unitCost` (Product.averageCost) is
// per PIECE; `unitPrice` is per SELLING UNIT (a BOX when unitsPerBox > 1). Keep in sync.

/** Cost of one selling unit: piece cost × unitsPerBox for boxed products, else the piece cost. */
export function costPerSellingUnit(unitCost: number, unitsPerBox?: number | null): number {
  const upb = Number(unitsPerBox ?? 0);
  return upb > 1 ? Number(unitCost) * upb : Number(unitCost);
}

/** Gross margin fraction on a line: (price − cost) / price. null when price ≤ 0 or cost unknown. */
export function computeMarginFraction(
  unitPrice: number,
  unitCost: number | null | undefined,
  unitsPerBox?: number | null,
): number | null {
  if (unitCost == null || !Number.isFinite(Number(unitCost))) return null;
  const price = Number(unitPrice);
  if (!(price > 0)) return null;
  const cost = costPerSellingUnit(Number(unitCost), unitsPerBox);
  return (price - cost) / price;
}

/** The selling-unit price that yields exactly `floor` margin for the given piece cost. */
export function priceForMarginFloor(
  unitCost: number,
  floor: number,
  unitsPerBox?: number | null,
): number {
  const cost = costPerSellingUnit(Number(unitCost), unitsPerBox);
  const f = Math.min(Math.max(Number(floor) || 0, 0), 0.99);
  return roundMoney(cost / (1 - f));
}

export type MarginClass = "ok" | "warn" | "belowFloor" | "belowCost";

/**
 * Classify a margin fraction against a floor:
 * `belowCost` (< 0) · `belowFloor` (< floor) · `warn` (within 5 points above floor) · `ok`.
 */
export function classifyMargin(margin: number | null, floor: number): MarginClass | null {
  if (margin == null) return null;
  if (margin < 0) return "belowCost";
  if (margin < floor) return "belowFloor";
  if (margin < floor + 0.05) return "warn";
  return "ok";
}

// ─── Category tax (regulated items, Phase 4 W3) ───────────────────────────────
// A per-category levy that is a SEPARATE dimension from boxed-line price
// proration: per-unit taxes apply to the PIECE count (never the boxed subtotal),
// so they compose with computeLineSubtotal without re-introducing the unitsPerBox
// over-charge. Keep all three mirrors in sync.

export type CategoryTaxType =
  | "EXCISE_PER_UNIT"
  | "PERCENT_OF_SALE"
  | "PER_VOLUME"
  | "DEPOSIT_PER_CONTAINER"
  | "NONE";

export interface CategoryTaxInput {
  taxType: CategoryTaxType;
  /** PERCENT_OF_SALE → a fraction (0.05 = 5%); otherwise $ per unit of `unitBasis`. */
  rate: number;
  /** True when the tax is already baked into the price (shown "incl.", not added on top). */
  priceIncludesTax?: boolean;
  /**
   * Quantity expressed in the category's `unitBasis` — the multiplicand for
   * per-unit taxes. The CALLER converts to the basis: EXCISE_PER_UNIT and
   * DEPOSIT_PER_CONTAINER pass the piece count (1 piece = 1 pack/container);
   * PER_VOLUME passes the true volume (pieces × volume-per-piece, e.g. ounces).
   * May be fractional (volume) and may be negative (a return/reversal line — the
   * tax then reverses in sign). Unused by PERCENT_OF_SALE.
   */
  unitBasisQty: number;
  /** The line's net sale (computeLineSubtotal result) — only used by PERCENT_OF_SALE. */
  lineSubtotal: number;
}

/**
 * Compute the category (regulated) tax for one line, rounded to cents. Input
 * signs are preserved, so a return/reversal line (negative qty or subtotal)
 * yields a negative tax.
 *
 * - PERCENT_OF_SALE: `rate` × subtotal. When `priceIncludesTax`, the subtotal
 *   already contains the tax, so the embedded portion is `subtotal × rate/(1+rate)`.
 * - EXCISE_PER_UNIT / PER_VOLUME / DEPOSIT_PER_CONTAINER: `rate` × `unitBasisQty`.
 *   A per-unit levy on the quantity-in-basis, orthogonal to how price is prorated
 *   across boxes — never derive it from the boxed subtotal.
 * - NONE (or `rate` ≤ 0): 0.
 */
export function computeCategoryTax(input: CategoryTaxInput): number {
  const rate = Number(input.rate) || 0;
  if (rate <= 0) return 0;
  const basisQty = Number(input.unitBasisQty) || 0;
  const subtotal = Number(input.lineSubtotal) || 0;
  switch (input.taxType) {
    case "PERCENT_OF_SALE":
      return input.priceIncludesTax
        ? roundMoney((subtotal * rate) / (1 + rate))
        : roundMoney(subtotal * rate);
    case "EXCISE_PER_UNIT":
    case "PER_VOLUME":
    case "DEPOSIT_PER_CONTAINER":
      return roundMoney(rate * basisQty);
    case "NONE":
    default:
      return 0;
  }
}

// ─── Promotions (P5-04, + BUY_N_GET_M) ────────────────────────────────────────
// A promotion adjusts the per-SELLING-UNIT price of a matching line. It composes
// with computeLineSubtotal exactly like any other unitPrice: resolve the NET
// selling-unit price here, then feed it (with boxes/pieces/unitsPerBox) through
// computeLineSubtotal so boxed lines are prorated. NEVER multiply a per-piece
// discount by the piece count — that re-introduces the unitsPerBox over-charge.
//
// Discount convention (mirrors the operator override): a promoted line stores the
// NET unitPrice + the pre-promo price as originalPrice (strikethrough); the saving
// is (originalPrice − unitPrice), never a separate discount amount (no double-count).
//
// BUY_N_GET_M ("buy N get M free") is a DIFFERENT mechanic: it never touches the
// per-unit price. It carries unitPrice = base, originalPrice = null, and a
// freeUnits count of whole SELLING units (boxes for a boxed line — loose pieces
// NEVER count) made free; the caller feeds freeUnits straight into
// computeLineSubtotal, which subtracts whole units before pricing. This keeps the
// saving EXACT — never a rounded net-unit-price (e.g. $35 × 5/6 = $29.1667 would
// drift cents when multiplied back).
//
// This block is byte-identical in the web + mobile mirrors — change all three.

export type PromotionType = "PERCENT" | "FIXED" | "QTY_BREAK" | "BUY_N_GET_M";
export type PromotionScope = "ALL" | "CATEGORY" | "PRODUCTS";

/** A promotion's typed rule — already tenant- and window-filtered by the caller. */
export interface PromotionRule {
  id: string;
  type: PromotionType;
  /**
   * PERCENT / QTY_BREAK: percent off (0–100). FIXED: $ off per SELLING UNIT (the
   * box price when boxed). BUY_N_GET_M: free quantity M — an integer ≥ 1.
   */
  value: number;
  /**
   * QTY_BREAK threshold in PIECES; the break applies only when qtyPieces ≥ minQty.
   * BUY_N_GET_M: buy quantity N — an integer ≥ 1, in whole SELLING units. Every
   * (N + M) whole selling units of the same product on a line makes M free (field
   * reuse: no dedicated Promotion columns for N/M).
   */
  minQty?: number | null;
  scope: PromotionScope;
  /** scope=CATEGORY: matched (exact string) against the product's category. */
  category?: string | null;
  /** scope=PRODUCTS: the product ids the promo is scoped to. */
  productIds?: string[] | null;
}

/** The line facts a promo needs to decide applicability + the qty-break gate. */
export interface PromoContext {
  productId: string;
  category?: string | null;
  /** Total line quantity in PIECES (post-normalizeBoxesPieces) — for the QTY_BREAK gate. */
  qtyPieces: number;
  /**
   * Total line quantity in whole SELLING units — boxes for a boxed line (mixed
   * lines count ONLY full boxes; loose pieces NEVER count), qty for a piece
   * line. Drives BUY_N_GET_M's free-unit math and the savings comparison in
   * `applyBestPromotion`. Callers use the would-be-added quantity (1 unit) when
   * pricing outside a cart, mirroring how `qtyPieces` is sourced today.
   */
  qtyUnits: number;
}

export interface PromoResult {
  /** Net (post-promo) selling-unit price. Equals the base when no promo applied. */
  unitPrice: number;
  /** Pre-promo base price for the strikethrough — null when no promo applied. */
  originalPrice: number | null;
  /** The winning promotion id, or null when none applied. */
  appliedPromoId: string | null;
  /**
   * Whole selling units made free by a BUY_N_GET_M promo. 0 for every other
   * type and when no promo applied — feed straight into `computeLineSubtotal`'s
   * `freeUnits` param; NEVER re-derive a discounted unit price for this type.
   */
  freeUnits: number;
}

/** Does a promotion's scope cover this product? */
export function promotionMatchesProduct(promo: PromotionRule, ctx: PromoContext): boolean {
  switch (promo.scope) {
    case "ALL":
      return true;
    case "CATEGORY":
      return !!promo.category && !!ctx.category && promo.category === ctx.category;
    case "PRODUCTS":
      return (promo.productIds ?? []).includes(ctx.productId);
    default:
      return false;
  }
}

/**
 * Net selling-unit price for ONE promo, or null if it doesn't apply to this line
 * (wrong scope, qty-break threshold not met) or doesn't actually lower the price.
 * `basePrice` is the customer's pre-promo selling-unit price (their tier price).
 * Rounded to cents; a promo may never raise the price and never go below 0.
 * BUY_N_GET_M never has a net price — see `promoBogoFreeUnits` below.
 */
function promoNetPrice(basePrice: number, promo: PromotionRule, ctx: PromoContext): number | null {
  if (!promotionMatchesProduct(promo, ctx)) return null;
  const value = Number(promo.value) || 0;
  if (value <= 0) return null;
  let net: number;
  switch (promo.type) {
    case "PERCENT":
      net = basePrice * (1 - Math.min(value, 100) / 100);
      break;
    case "QTY_BREAK": {
      const threshold = Number(promo.minQty ?? 0);
      if (!(threshold > 0) || ctx.qtyPieces < threshold) return null; // gated on the PIECE count
      net = basePrice * (1 - Math.min(value, 100) / 100);
      break;
    }
    case "FIXED":
      net = basePrice - value; // $ off per selling unit (never per piece — see header)
      break;
    default:
      return null; // BUY_N_GET_M (and anything unrecognized) has no net-price form
  }
  net = roundMoney(Math.max(0, net));
  return net < basePrice ? net : null; // only apply when it genuinely lowers the price
}

/**
 * Free-units count for a BUY_N_GET_M ("buy N get M free") promo, or null if it
 * doesn't apply — wrong type/scope, a non-integer or `< 1` N or M (ignored, never
 * a crash), or fewer than one full (N + M) block of whole selling units on the
 * line yet. `minQty` stores N (buy qty), `value` stores M (free qty).
 * PIECES NEVER COUNT: `ctx.qtyUnits` must already be whole selling units only
 * (the caller's job — boxes for a boxed line, pieces for a piece line).
 * `freeUnits = floor(qtyUnits / (N + M)) * M` — the owner's exact table for
 * N=5, M=1: 5 units → 0 free, 6 → 1, 11 → 1, 12 → 2, 18 → 3.
 */
function promoBogoFreeUnits(promo: PromotionRule, ctx: PromoContext): number | null {
  if (promo.type !== "BUY_N_GET_M") return null;
  if (!promotionMatchesProduct(promo, ctx)) return null;
  const n = Number(promo.minQty);
  const m = Number(promo.value);
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(m) || m < 1) return null;
  const qtyUnits = Number(ctx.qtyUnits) || 0;
  const freeUnits = Math.floor(qtyUnits / (n + m)) * m;
  return freeUnits > 0 ? freeUnits : null;
}

/**
 * Apply the best (largest-saving) applicable promotion to a base selling-unit
 * price. Single, non-stacking: the promo yielding the largest total dollar
 * saving for the line's current quantity wins; equal savings fall back to the
 * LOWEST net unit price and then to promo id (determinism, as today) — so a
 * line with no whole selling units yet, where every price promo saves $0, still
 * picks the deepest discount exactly as it did before. Price promos
 * (PERCENT/FIXED/QTY_BREAK) save `(base - net) × qtyUnits`; BUY_N_GET_M saves
 * `freeUnits × base` and returns `unitPrice = base` unchanged — the free units
 * reduce the SUBTOTAL via `computeLineSubtotal`'s `freeUnits` param, never a
 * rounded net unit price (see the header). Returns the base unchanged,
 * `freeUnits: 0`, when none apply.
 */
export function applyBestPromotion(
  basePrice: number,
  promos: PromotionRule[],
  ctx: PromoContext,
): PromoResult {
  const base = roundMoney(basePrice);
  const qtyUnits = Number(ctx.qtyUnits) || 0;
  let bestSaving: number | null = null;
  let bestId: string | null = null;
  let bestNet = base;
  let bestFreeUnits = 0;
  for (const promo of promos) {
    let saving: number;
    let net = base;
    let freeUnits = 0;
    if (promo.type === "BUY_N_GET_M") {
      const free = promoBogoFreeUnits(promo, ctx);
      if (free == null) continue;
      freeUnits = free;
      saving = roundMoney(freeUnits * base);
    } else {
      const promoNet = promoNetPrice(base, promo, ctx);
      if (promoNet == null) continue;
      net = promoNet;
      saving = roundMoney((base - net) * qtyUnits);
    }
    if (
      bestSaving == null ||
      saving > bestSaving ||
      (saving === bestSaving &&
        (net < bestNet || (net === bestNet && bestId != null && promo.id < bestId)))
    ) {
      bestSaving = saving;
      bestId = promo.id;
      bestNet = net;
      bestFreeUnits = freeUnits;
    }
  }
  if (bestSaving == null || bestId == null) {
    return { unitPrice: base, originalPrice: null, appliedPromoId: null, freeUnits: 0 };
  }
  if (bestFreeUnits > 0) {
    return {
      unitPrice: base,
      originalPrice: null,
      appliedPromoId: bestId,
      freeUnits: bestFreeUnits,
    };
  }
  return { unitPrice: bestNet, originalPrice: base, appliedPromoId: bestId, freeUnits: 0 };
}

// ─── Zero-price guard: a rule that clamps in-scope products to $0.00 ──────────
// promoNetPrice floors the net at 0, so a FIXED "$35 off" rule prices EVERY
// in-scope product at or below $35 at exactly $0.00 — in the buyer catalog AND
// on the invoice the order bills. The rule is legal; the operator just cannot
// see its blast radius while typing it (2026-08-20: one ALL-scoped $35-off promo
// put 699 of a tenant's 1,767 products on the portal at $0.00 with a -100% chip).
// These pure helpers compute that blast radius from the catalog so the promotion
// editor can warn and the API can refuse the write unless it is confirmed.
// Keep all three mirrors in sync.

/** How many product names a scan carries back for the operator-facing warning. */
export const ZERO_PRICE_EXAMPLE_LIMIT = 5;

/** The catalog facts the zero-price scan needs — a product row from any surface. */
export interface PromoScopeProduct {
  id: string;
  name?: string | null;
  category?: string | null;
  /** Canonical SELLING-UNIT price (`Product.pricePerUnit` — the BOX price when boxed). */
  price: number | string | null | undefined;
}

export interface ZeroPriceImpact {
  /** In-scope products the rule would clamp to $0.00. */
  count: number;
  /** How many products the rule's scope covers at all — the denominator. */
  inScope: number;
  /** Up to {@link ZERO_PRICE_EXAMPLE_LIMIT} names of the clamped products. */
  examples: string[];
}

/**
 * Cheap shape check: can this rule zero ANY price at all? A FIXED amount always
 * can (some product is always cheap enough); PERCENT/QTY_BREAK only at a full
 * 100% off. Callers use it to skip the catalog scan for ordinary rules.
 *
 * Only the mechanics with a NET-PRICE form can reach $0.00, so the switch is
 * explicit rather than a `!== "FIXED"` fallthrough — `value` does not mean
 * "percent" for every type. BUY_N_GET_M stores M (free units) in `value`, and a
 * bare `value >= 100` would send "buy 1 get 100 free" on a pointless full-catalogue
 * scan. It could never be flagged anyway: `promoBogoFreeUnits` requires N >= 1, so
 * `floor(qtyUnits / (N + M)) * M` is strictly less than `qtyUnits` — a free-unit
 * rule can discount a line steeply but can never make one free.
 */
export function ruleCanZeroPrice(promo: Pick<PromotionRule, "type" | "value">): boolean {
  const value = Number(promo.value) || 0;
  if (value <= 0) return false;
  switch (promo.type) {
    case "FIXED":
      return true;
    case "PERCENT":
    case "QTY_BREAK":
      return value >= 100;
    default:
      return false; // no net-price form ⇒ nothing for the scan to find
  }
}

/** The qty a rule is judged at — a QTY_BREAK bites at its own threshold. */
function zeroScanQtyPieces(promo: PromotionRule): number {
  return Math.max(1, Math.trunc(Number(promo.minQty ?? 0)) || 1);
}

/**
 * Would this rule price ONE product at exactly $0.00? A product already priced at
 * $0 is never counted — the promotion is not what makes that one free.
 */
export function promotionZeroesProduct(product: PromoScopeProduct, promo: PromotionRule): boolean {
  const base = roundMoney(Number(product.price) || 0);
  if (!(base > 0)) return false;
  const net = promoNetPrice(base, promo, {
    productId: product.id,
    category: product.category ?? null,
    qtyPieces: zeroScanQtyPieces(promo),
    // One selling unit: the question is what a single unit would ring up at.
    qtyUnits: 1,
  });
  return net === 0;
}

/**
 * Scan a catalog for the products a rule would sell for $0.00. Callers may
 * pre-filter to the rule's scope in SQL; the scope is re-checked here either way,
 * so an unfiltered catalog is equally correct (just more work).
 */
export function scanPromotionZeroPrice(
  products: PromoScopeProduct[],
  promo: PromotionRule,
): ZeroPriceImpact {
  const impact: ZeroPriceImpact = { count: 0, inScope: 0, examples: [] };
  const qtyPieces = zeroScanQtyPieces(promo);
  for (const product of products) {
    const inScope = promotionMatchesProduct(promo, {
      productId: product.id,
      category: product.category ?? null,
      qtyPieces,
      qtyUnits: 1,
    });
    if (!inScope) continue;
    impact.inScope += 1;
    if (!promotionZeroesProduct(product, promo)) continue;
    impact.count += 1;
    if (impact.examples.length < ZERO_PRICE_EXAMPLE_LIMIT) {
      impact.examples.push(product.name || product.id);
    }
  }
  return impact;
}

/** The one operator-facing sentence for a zero-price warning or refusal. */
export function zeroPriceWarning(impact: ZeroPriceImpact): string {
  const noun = impact.count === 1 ? "product" : "products";
  return `This discount is larger than the price of ${impact.count} ${noun} in scope — they would sell for $0.00.`;
}

// ─── Price-override direction: upsell vs discount ─────────────────────────────
// A one-time operator override stores the NET unitPrice + the catalog base as
// originalPrice (the discount convention above). The DIRECTION is derived, not
// stored: an UPSELL sells ABOVE the base, a DISCOUNT below. Scoped to MANUAL so a
// premium tier (SPECIAL, where originalPrice = list < unitPrice = tier) is never
// mistaken for an upsell. Keep all three mirrors in sync.

export interface PriceOverrideLine {
  priceType?: string | null;
  unitPrice: number | string;
  originalPrice?: number | string | null;
}

/** True when a line is an operator MANUAL override priced ABOVE the catalog base. */
export function isUpsellLine(line: PriceOverrideLine): boolean {
  if (line.priceType !== "MANUAL" || line.originalPrice == null) return false;
  return Number(line.unitPrice) > Number(line.originalPrice);
}

/**
 * A customer's EFFECTIVE buyer price for a product. An operator's remembered
 * upsell — a saved override net price ABOVE the catalog LIST price — is sticky and
 * overrides the tier everywhere the buyer is priced (catalog, cart, checkout). A
 * remembered price at or below list does NOT stick, so a one-time discount never
 * becomes a standing buyer price (and never RAISES a low-tier customer). Returns
 * the tier price when there is no sticky upsell.
 */
export function effectiveBuyerPrice(
  tierPrice: number,
  listPrice: number,
  rememberedPrice: number | null | undefined,
): number {
  const tier = Number(tierPrice) || 0;
  if (rememberedPrice == null) return tier;
  const remembered = Number(rememberedPrice);
  return remembered > Number(listPrice) ? roundMoney(remembered) : tier;
}

// ─── Qty display: boxes + pieces split ────────────────────────────────────────
// A boxed line stores its denomination (boxes/pieces/unitsPerBox snapshots) on
// the order AND invoice line, but read surfaces used to render only the raw
// piece count. One shared formatter so "2 boxes + 3 pcs" reads identically on
// the order detail, invoice detail, and PDF. Keep all three mirrors in sync.
//
// DOCUMENT wording stays "boxes + pcs" deliberately (2026-07-30): it is shorter,
// scans better in the narrow PDF qty column, and matches how wholesale paperwork
// normally reads. The Case/Unit vocabulary is for the OPERATOR-facing setup and
// selling UI (units-per-case field, Case|Unit toggle) — different audience.
// `unitLabel` still overrides the loose-unit noun per product.

export interface QtySplitInput {
  /** Total quantity (pieces for boxed lines). Used when no split is stored. */
  qty: number | string;
  /** Stored split — null/undefined ⇒ not a boxed line (render plain qty). */
  boxes?: number | null;
  pieces?: number | null;
  /** Label for loose pieces; defaults to "pcs". */
  unitLabel?: string | null;
}

/** "2 boxes + 3 pcs" | "1 box" | "4 pcs" | plain trimmed qty (non-boxed line). */
export function formatQtySplit({ qty, boxes, pieces, unitLabel }: QtySplitInput): string {
  if (boxes == null && pieces == null) {
    const n = Number(qty);
    if (!Number.isFinite(n)) return String(qty);
    // Integers render bare; fractional qty keeps up to 3 dp (Decimal(10,3)).
    return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
  }
  const b = Math.max(0, Math.trunc(Number(boxes ?? 0)));
  const p = Math.max(0, Math.trunc(Number(pieces ?? 0)));
  const label = (unitLabel ?? "").trim() || "pcs";
  const parts: string[] = [];
  if (b > 0) parts.push(`${b} ${b === 1 ? "box" : "boxes"}`);
  if (p > 0) parts.push(`${p} ${label}`);
  return parts.length > 0 ? parts.join(" + ") : "0";
}
