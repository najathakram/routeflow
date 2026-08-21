/**
 * Shared line-item subtotal calculation + money helpers.
 *
 * `pricePerUnit` on a Product is the canonical SELLING-UNIT price the operator
 * entered. For products with `unitsPerBox > 1` the canonical selling unit is
 * one BOX (because operators almost always quote and price by the case);
 * issuing loose pieces is prorated as `pricePerUnit / unitsPerBox`.
 *
 * Historically the codebase computed `subtotal = pricePerUnit * qty` where
 * `qty` was already expanded to total pieces (boxes × unitsPerBox + pieces).
 * That over-charged boxed items by a factor of `unitsPerBox` (a single $43.75
 * box of 6 came out as $262.50). This helper centralises the correct formula
 * so orders, invoices, estimates, vendor bills and the buyer cart all agree.
 *
 * MONEY DISCIPLINE: every monetary result returned from here is rounded to
 * cents via {@link roundMoney}. Callers MUST also wrap their own aggregations
 * (sum of lines, tax, grand total) in {@link roundMoney} so floating-point
 * drift never reaches the database. The web and mobile mirrors
 * (`apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts`) keep identical
 * copies of these helpers — change all three together.
 */

/**
 * Round a monetary amount to 2 decimal places (cents), guarding against binary
 * floating-point drift (e.g. `0.1 + 0.2`). This is the single rounding policy
 * for the whole money pipeline — half-away-from-zero at the cent.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  // Scale to cents, nudge by EPSILON so values like 4.005 round up reliably,
  // then round and scale back. Math.round is half-up for positive numbers.
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

export interface NormalizedQty {
  /** Whole boxes (null for non-boxed products / no split). */
  boxes: number | null;
  /** Loose pieces below a full box (null for non-boxed products / no split). */
  pieces: number | null;
  /** Total quantity in pieces — always an integer. */
  qty: number;
}

/**
 * Force INTEGER boxes/pieces/qty and roll any loose pieces that reach a full
 * box up into the box count. Single source of truth for quantity hygiene so the
 * UI can never persist fractional units or a stale `pieces >= unitsPerBox`.
 *
 * - Boxed product (`unitsPerBox > 1`): derives a canonical `{boxes, pieces}`
 *   from whichever the caller supplied — an explicit boxes/pieces split OR a
 *   raw piece `qty` — and guarantees `pieces < unitsPerBox`.
 * - Non-boxed product: returns `{boxes: null, pieces: null, qty}` with `qty`
 *   coerced to a non-negative integer.
 */
export function normalizeBoxesPieces(input: {
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  unitsPerBox?: number | null;
}): NormalizedQty {
  const upb = Math.trunc(Number(input.unitsPerBox ?? 0));
  const hasBoxPackaging = upb > 1;

  if (hasBoxPackaging) {
    const splitProvided = input.boxes != null || input.pieces != null;
    const totalPieces = splitProvided
      ? Math.trunc(Number(input.boxes ?? 0)) * upb + Math.trunc(Number(input.pieces ?? 0))
      : Math.trunc(Number(input.qty ?? 0));
    const safeTotal = Math.max(0, totalPieces);
    return {
      boxes: Math.floor(safeTotal / upb),
      pieces: safeTotal % upb,
      qty: safeTotal,
    };
  }

  const qty = Math.max(0, Math.trunc(Number(input.qty ?? 0)));
  return { boxes: null, pieces: null, qty };
}

export interface LineSubtotalInput {
  unitPrice: number;
  /** Total qty in pieces — kept for backward compat & non-boxed products. */
  qty: number;
  /** Number of full boxes (only meaningful when unitsPerBox > 1). */
  boxes?: number | null;
  /** Loose pieces below a full box. */
  pieces?: number | null;
  /** Box size; null/1 means the product is sold as individual pieces. */
  unitsPerBox?: number | null;
  /**
   * Whole SELLING units made free by a BUY_N_GET_M promo (boxes for a boxed
   * line, pieces otherwise) — subtracted before pricing so the saving is
   * EXACT, never a rounded net-unit-price. Clamped so the line can never go
   * negative. Default 0: every existing call site is unaffected.
   */
  freeUnits?: number;
}

export function computeLineSubtotal(input: LineSubtotalInput): number {
  const { unitPrice, qty, boxes, pieces, unitsPerBox, freeUnits = 0 } = input;
  const free = Math.max(0, Math.trunc(Number(freeUnits) || 0));
  const upb = Number(unitsPerBox ?? 0);
  const hasBoxPackaging = upb > 1;
  const boxesPiecesProvided = boxes != null || pieces != null;

  if (hasBoxPackaging && boxesPiecesProvided) {
    // unitPrice is the BOX price. One box = unitPrice; loose pieces are prorated.
    const b = Number(boxes ?? 0);
    const p = Number(pieces ?? 0);
    const boxEquivalent = Math.max(0, b - free) + p / upb;
    return roundMoney(unitPrice * boxEquivalent);
  }

  // Non-boxed product (or caller didn't split): unitPrice is per piece, qty in pieces.
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

// ─── Margin: the "negotiation floor" (pos-cost-roles-spec §1) ─────────────────
// `unitCost` (Product.averageCost) is per PIECE. `unitPrice` is per SELLING UNIT
// (a BOX when unitsPerBox > 1, else a piece). Bring cost onto the selling-unit
// basis before comparing, or margins are wrong by a factor of unitsPerBox — the
// same class of bug the box-proration fix guards. Keep all three mirrors in sync.

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
  const f = Math.min(Math.max(Number(floor) || 0, 0), 0.99); // margin must stay < 1
  return roundMoney(cost / (1 - f));
}

export type MarginClass = "ok" | "warn" | "belowFloor" | "belowCost";

/**
 * Classify a margin fraction against a floor:
 * `belowCost` (< 0) · `belowFloor` (< floor) · `warn` (within 5 points above floor) · `ok`.
 * Returns null when margin is unknown (no cost).
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
