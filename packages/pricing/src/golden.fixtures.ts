/**
 * Golden money table for `golden.spec.ts` (T2) — the fixtures this package's
 * single source of money math is pinned against.
 *
 * Every `expected` value here is HAND-WORKED decimal arithmetic — never read
 * out of the implementation. That is deliberate: a wrong body (REG-B122's
 * EPSILON no-op, REG-B109's saving basis) is caught because the assertion is
 * against the mathematically correct value rather than against whatever the
 * code currently returns.
 *
 * REG-B50 / REG-B109 / REG-B122 rows pin the register's confirmed
 * counter-examples (see
 * `.claude/pipeline/2026-08-31-f04-pricing-mirrors/discovery.md`). The
 * remaining rows (computeLineSubtotal general cases, the tier ladder,
 * normalizeBoxesPieces, PRORATE_EDGE_FIXTURES' guard pins) are ordinary
 * coverage — they are NOT known to be currently broken, so they carry no
 * REG-B* token.
 */

// ─── roundMoney (REG-B122) ─────────────────────────────────────────────────

export interface RoundMoneyFixture {
  label: string;
  input: number;
  expected: number;
}

export const ROUND_MONEY_FIXTURES: RoundMoneyFixture[] = [
  // Half-away-from-zero at the cent: the digit in the thousandths place is
  // exactly 5, so the cent above is always the correct rounding regardless of
  // what the IEEE-754 double happens to store for the literal.
  { label: "2.135 -> 2.14", input: 2.135, expected: 2.14 },
  { label: "2.175 -> 2.18", input: 2.175, expected: 2.18 },
  { label: "2.385 -> 2.39", input: 2.385, expected: 2.39 },
  { label: "2.425 -> 2.43", input: 2.425, expected: 2.43 },
  { label: "4.015 -> 4.02", input: 4.015, expected: 4.02 },
  { label: "-2.135 -> -2.14 (sign preserved)", input: -2.135, expected: -2.14 },
  // 7.5% of $29.00 = 0.075 * 29.00 = 2.175 -> 2.18.
  { label: "0.075 * 29.00 -> 2.18", input: 0.075 * 29.0, expected: 2.18 },
  // 7.5% of $27.40 = 0.075 * 27.40 = 2.055 -> 2.06.
  { label: "0.075 * 27.40 -> 2.06", input: 0.075 * 27.4, expected: 2.06 },
  // 15% off $9.50: net = 9.50 * (1 - 0.15) = 9.50 * 0.85 = 8.075 -> 8.08.
  { label: "9.50 * 0.85 (15% off) -> 8.08", input: 9.5 * 0.85, expected: 8.08 },
  // 4.27 / 2 = 2.135 -> 2.14 (same tie as the first row, reached via division
  // instead of a literal — a different binary-representation path).
  { label: "4.27 / 2 -> 2.14", input: 4.27 / 2, expected: 2.14 },
];

// ─── computeLineSubtotal (no known divergence — R4 general parity) ─────────

export interface LineSubtotalFixtureInput {
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  freeUnits?: number;
}

export interface LineSubtotalFixture {
  label: string;
  input: LineSubtotalFixtureInput;
  expected: number;
}

export const COMPUTE_LINE_SUBTOTAL_FIXTURES: LineSubtotalFixture[] = [
  // Non-boxed: 220 * 2 = 440.
  { label: "non-boxed 220 x 2 = 440", input: { unitPrice: 220, qty: 2 }, expected: 440 },
  // Boxed, whole boxes only: 2 boxes of an 11-pack @ $220/box = 440 (never 22 x 220).
  {
    label: "2 boxes @ $220/box, upb 11 -> 440",
    input: { unitPrice: 220, qty: 22, boxes: 2, pieces: 0, unitsPerBox: 11 },
    expected: 440,
  },
  // Loose pieces below a full box: 220 * (1 + 10/11) = 220 + 200 = 420.00.
  {
    label: "1 box + 10 loose of an 11-pack -> 420",
    input: { unitPrice: 220, qty: 21, boxes: 1, pieces: 10, unitsPerBox: 11 },
    expected: 420,
  },
  // BUY_N_GET_M freeUnits on a boxed line: 35 * (12 - 2) = 350.00.
  {
    label: "12 boxes @ $35, 2 free -> 350",
    input: { unitPrice: 35, qty: 12, boxes: 12, pieces: 0, unitsPerBox: 6, freeUnits: 2 },
    expected: 350,
  },
  // freeUnits on a non-boxed line: 2 * (6 - 1) = 10.00.
  {
    label: "6 pieces @ $2, 1 free -> 10",
    input: { unitPrice: 2, qty: 6, freeUnits: 1 },
    expected: 10,
  },
];

// ─── applyBestPromotion selection (REG-B109) ───────────────────────────────

export interface FixturePromoRule {
  id: string;
  type: "PERCENT" | "FIXED" | "QTY_BREAK" | "BUY_N_GET_M";
  value: number;
  minQty?: number | null;
  scope: "ALL" | "CATEGORY" | "PRODUCTS";
  category?: string | null;
  productIds?: string[] | null;
}

export interface PromotionSelectionFixture {
  label: string;
  basePrice: number;
  promos: FixturePromoRule[];
  /**
   * `boxes`/`pieces`/`unitsPerBox` are the line's real denomination — optional on
   * `PromoContext` (R7) and REQUIRED for the full-quantity comparison, because a
   * `qtyPieces`/`qtyUnits` pair cannot be decomposed back into a split (71 pieces
   * over 2 whole units fits upb 24 AND upb 35). Rows that omit them pin the
   * `qtyUnits`-only fallback instead.
   */
  ctx: {
    productId: string;
    category: string | null;
    qtyPieces: number;
    qtyUnits: number;
    boxes?: number | null;
    pieces?: number | null;
    unitsPerBox?: number | null;
  };
  expected: {
    appliedPromoId: string | null;
    unitPrice: number;
    originalPrice: number | null;
    freeUnits: number;
  };
  bill: { qty: number; boxes: number | null; pieces: number | null; unitsPerBox: number | null };
  expectedBilled: number;
}

const REG_B109_BOGO: FixturePromoRule = {
  id: "bogo",
  type: "BUY_N_GET_M",
  value: 1,
  minQty: 1,
  scope: "ALL",
}; // buy 1 get 1 free
const REG_B109_PERCENT: FixturePromoRule = { id: "pct", type: "PERCENT", value: 49, scope: "ALL" };
const REG_B109_PERCENT_50: FixturePromoRule = {
  id: "pct50",
  type: "PERCENT",
  value: 50,
  scope: "ALL",
};

export const APPLY_BEST_PROMOTION_FIXTURES: PromotionSelectionFixture[] = [
  {
    label:
      "REG-B109: 2 boxes + 23 pieces @ $120/box (upb 24) — PERCENT(49%) truly saves more than " +
      "BUY_1_GET_1 and must be selected over it",
    basePrice: 120,
    promos: [REG_B109_BOGO, REG_B109_PERCENT],
    ctx: {
      productId: "p1",
      category: "Beverages",
      qtyPieces: 71,
      qtyUnits: 2,
      boxes: 2,
      pieces: 23,
      unitsPerBox: 24,
    },
    // Derivation: full-price bill = 120 * (2 + 23/24) = 355.00.
    // BOGO: 1 free box (floor(2/(1+1))*1=1) -> bills 120*(2-1+23/24) = 235.00, true saving 120.00.
    // PERCENT: net = 120*(1-49/100) = 61.20 -> bills 61.20*(2+23/24) = 181.05, true saving 173.95.
    // 173.95 > 120.00, so PERCENT must win (today's buggy basis compares BOGO's
    // exact 120.00 against PERCENT's whole-box-only (120-61.20)*2=117.60 and picks BOGO).
    expected: { appliedPromoId: "pct", unitPrice: 61.2, originalPrice: 120, freeUnits: 0 },
    bill: { qty: 71, boxes: 2, pieces: 23, unitsPerBox: 24 },
    expectedBilled: 181.05,
  },
  {
    label:
      "whole-box-only control: 6 boxes @ $120 — both the old and new saving bases already agree " +
      "BOGO wins (guards T-B109 against over-correction)",
    basePrice: 120,
    promos: [REG_B109_BOGO, REG_B109_PERCENT],
    ctx: { productId: "p1", category: "Beverages", qtyPieces: 144, qtyUnits: 6 },
    // Derivation: no loose pieces, so boxEquivalent == qtyUnits == 6 exactly —
    // the old (whole-box) and new (full-quantity) saving bases are IDENTICAL.
    // BOGO: 3 free boxes (floor(6/2)*1=3) -> saves 3*120 = 360.00.
    // PERCENT: net=61.20 -> saves (120-61.20)*6 = 352.80 under either basis.
    // 360.00 > 352.80, so BOGO wins under BOTH the buggy and the fixed formula.
    expected: { appliedPromoId: "bogo", unitPrice: 120, originalPrice: null, freeUnits: 3 },
    bill: { qty: 144, boxes: 6, pieces: 0, unitsPerBox: 24 },
    expectedBilled: 360,
  },
  {
    // TIE-BREAK pin for the selection comparison itself. The two REG-B109 rows
    // above only prove the winner is the candidate billing STRICTLY less; they
    // say nothing about what happens when two candidates bill the SAME total,
    // so a comparison weakened from `<` to `<=` (last promo in the list wins)
    // passes both of them. That is a real defect: promo choice — and the unit
    // price the buyer is shown — would depend on the order the rules came back
    // from the database. This row pins the documented fallback instead: equal
    // billed totals resolve to the LOWEST net selling-unit price.
    label:
      "tie-break: BUY_1_GET_1 and PERCENT(50%) bill the same $120 — the LOWEST net unit price " +
      "wins, never the promo that happens to be last in the list",
    basePrice: 120,
    // Deliberate order: the percent promo is FIRST, so `<=` would let the BOGO
    // displace it on the equal-billed comparison and the row would fail.
    promos: [REG_B109_PERCENT_50, REG_B109_BOGO],
    ctx: {
      productId: "p1",
      category: "Beverages",
      qtyPieces: 48,
      qtyUnits: 2,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 24,
    },
    // Derivation: 2 whole boxes of a 24-pack @ $120/box, no loose pieces.
    // BOGO: 1 free box (floor(2/(1+1))*1=1) -> bills 120*(2-1) = 120.00.
    // PERCENT(50%): net = 120*(1-50/100) = 60.00 -> bills 60.00*2 = 120.00.
    // Both bill exactly 120.00, so the saving comparison cannot separate them;
    // the documented fallback picks the lower net unit price, 60.00 < 120.00,
    // i.e. PERCENT — and the buyer sees $60.00 struck through from $120.00
    // rather than two full-price boxes with one of them free.
    expected: { appliedPromoId: "pct50", unitPrice: 60, originalPrice: 120, freeUnits: 0 },
    bill: { qty: 48, boxes: 2, pieces: 0, unitsPerBox: 24 },
    expectedBilled: 120,
  },
];

// ─── prorateLineSubtotal (REG-B50) ─────────────────────────────────────────

export interface ProrateLineSubtotalFixture {
  label: string;
  /**
   * Nullable on purpose: the package's signature accepts
   * `number | null | undefined` (mobile's callers hand `OrderItem.subtotal` straight
   * through), and "a line carrying no stored money bills $0.00" is part of the
   * contract the single implementation owes — see PRORATE_EDGE_FIXTURES.
   */
  storedSubtotal: number | null;
  deliveredQty: number;
  orderQty: number;
  freeUnits: number;
  /**
   * Qty units per whole free unit — the oracle's `freeUnitSize`. Omitted (⇒ 1)
   * on selling-unit rows, where `freeUnits` and `orderQty` share one axis.
   */
  freeUnitSize?: number;
  expected: number;
}

export const PRORATE_LINE_SUBTOTAL_FIXTURES: ProrateLineSubtotalFixture[] = [
  // ── The basisQty CAP (Fable final-pass major, fixed in the close-out round) ──
  // With freeUnitSize > 1 the floored allocation grants the free unit only near
  // 100% delivered, so the UNCAPPED billed share exceeded paidQty and a partial
  // delivery billed MORE than the whole line's agreed subtotal. Worked line:
  // 2 boxes + 2 loose of a 4-pack @ $10/box, BUY_1_GET_1 ⇒ stored $15.00,
  // orderQty 10 pieces, freeUnits 1, freeUnitSize 4, paidQty = 10 − 4 = 6.
  {
    // freeUnitsThrough(9)=floor(1*9/10)=0 ⇒ billedThrough=9 ⇒ UNCAPPED 15*9/6=22.50 (150%!).
    // Capped: min(9, 6)=6 ⇒ 15*6/6 = 15.00 — a partial never exceeds the agreed price.
    label: "CAP: 9 of 10 delivered, 1 free 4-pack -> 15.00 (uncapped billed 22.50)",
    storedSubtotal: 15,
    deliveredQty: 9,
    orderQty: 10,
    freeUnits: 1,
    freeUnitSize: 4,
    expected: 15.0,
  },
  {
    // freeUnitsThrough(7)=0 ⇒ billed 7 ⇒ uncapped 17.50; capped min(7,6)=6 ⇒ 15.00.
    label: "CAP: 7 of 10 delivered, 1 free 4-pack -> 15.00 (uncapped billed 17.50)",
    storedSubtotal: 15,
    deliveredQty: 7,
    orderQty: 10,
    freeUnits: 1,
    freeUnitSize: 4,
    expected: 15.0,
  },
  {
    // Below the cap region — guards over-correction: freeUnitsThrough(5)=0 ⇒ billed 5 ≤ 6,
    // 15*5/6 = 12.50 exactly as before the cap.
    label: "CAP-control: 5 of 10 delivered, 1 free 4-pack -> 12.50 (cap not engaged)",
    storedSubtotal: 15,
    deliveredQty: 5,
    orderQty: 10,
    freeUnits: 1,
    freeUnitSize: 4,
    expected: 12.5,
  },
  {
    // Full delivery still copies stored verbatim: freeUnitsThrough(10)=1 ⇒ billed 10−4=6 ⇒ 15.00.
    label: "CAP-control: 10 of 10 delivered, 1 free 4-pack -> 15.00 (full copies stored)",
    storedSubtotal: 15,
    deliveredQty: 10,
    orderQty: 10,
    freeUnits: 1,
    freeUnitSize: 4,
    expected: 15.0,
  },
  {
    // Server telescope (invoices.service.ts:827-897), freeUnitSize=1: storedFreeUnits=1,
    // paidQty=6-1=5, freeUnitsThrough(5)=min(1,floor(5/6))=0, billedThrough(5)=5-0=5,
    // subtotal = round(50*5/5) - round(50*0/5) = 50.00 - 0 = 50.00.
    label: "stored $50, 5 of 6 delivered, 1 free unit -> 50.00 (paid-basis telescope)",
    storedSubtotal: 50,
    deliveredQty: 5,
    orderQty: 6,
    freeUnits: 1,
    expected: 50.0,
  },
  {
    // freeUnitsThrough(3)=min(1,floor(3/6))=0, billedThrough(3)=3,
    // subtotal = round(50*3/5) - 0 = 30.00.
    label: "stored $50, 3 of 6 delivered, 1 free unit -> 30.00",
    storedSubtotal: 50,
    deliveredQty: 3,
    orderQty: 6,
    freeUnits: 1,
    expected: 30.0,
  },
  {
    // Full delivery: freeUnitsThrough(6)=min(1,floor(6/6))=1, billedThrough(6)=6-1=5,
    // subtotal = round(50*5/5) = 50.00 — a full bill copies the stored subtotal verbatim.
    label: "stored $50, 6 of 6 delivered (full), 1 free unit -> 50.00 (copies stored verbatim)",
    storedSubtotal: 50,
    deliveredQty: 6,
    orderQty: 6,
    freeUnits: 1,
    expected: 50.0,
  },
  {
    // No free units: basisQty=orderQty=6, billedThrough(cumQty)=cumQty,
    // subtotal = round(50*3/6) = 25.00 — the plain linear case, unchanged.
    label: "no free units, 3 of 6 delivered -> 25.00 (unchanged linear case)",
    storedSubtotal: 50,
    deliveredQty: 3,
    orderQty: 6,
    freeUnits: 0,
    expected: 25.0,
  },
  {
    // BOX-SPLIT line — the axis the driver screens actually feed: `orderQty` and
    // `deliveredQty` are PIECES while `freeUnits` counts BOXES, so one free unit
    // is worth unitsPerBox pieces (the oracle's `freeUnitSize`, computed at
    // invoices.service.ts as `isBoxSplit && unitsPerBox > 0 ? unitsPerBox : 1`).
    // 6 boxes of a 24-pack @ $120, BUY_1_GET_1 -> 3 free boxes, stored 120*(6-3)
    // = $360, qty 144 pieces. Driver delivers 3 boxes = 72 pieces:
    //   freeUnitSize=24, paidQty=144-3*24=72, basisQty=72,
    //   freeUnitsThrough(72)=min(3,floor(3*72/144))=min(3,1)=1,
    //   billedThrough(72)=72-1*24=48, subtotal=round(360*48/72)=240.00.
    // Dropping freeUnitSize (treating 3 free BOXES as 3 free pieces) gives
    // 360*71/141 = $181.28 — a $58.72 shortfall the driver never collects.
    label: "box-split: stored $360, 72 of 144 pieces (3 free boxes of 24) -> 240.00",
    storedSubtotal: 360,
    deliveredQty: 72,
    orderQty: 144,
    freeUnits: 3,
    freeUnitSize: 24,
    expected: 240.0,
  },
  {
    // Same box-split line delivered IN FULL: freeUnitsThrough(144)=min(3,3)=3,
    // billedThrough(144)=144-3*24=72, subtotal=round(360*72/72)=360.00 — a full
    // delivery still copies the stored subtotal verbatim on the boxes axis.
    label: "box-split: stored $360, full 144 of 144 pieces -> 360.00 (copies stored verbatim)",
    storedSubtotal: 360,
    deliveredQty: 144,
    orderQty: 144,
    freeUnits: 3,
    freeUnitSize: 24,
    expected: 360.0,
  },
  {
    // Box-split with a partial that lands mid-box-count: 12 boxes of a 24-pack
    // @ $35, 2 free -> stored 35*(12-2) = $350, qty 288 pieces. Driver delivers
    // 10 boxes = 240 pieces: paidQty=288-2*24=240, basisQty=240,
    // freeUnitsThrough(240)=min(2,floor(2*240/288))=min(2,1)=1,
    // billedThrough(240)=240-24=216, subtotal=round(350*216/240)=315.00.
    // Without freeUnitSize: 350*239/286 = $292.48, a $22.52 shortfall.
    label: "box-split: stored $350, 240 of 288 pieces (2 free boxes of 24) -> 315.00",
    storedSubtotal: 350,
    deliveredQty: 240,
    orderQty: 288,
    freeUnits: 2,
    freeUnitSize: 24,
    expected: 315.0,
  },
  {
    // Degenerate box-split where the free units are worth the WHOLE line
    // (paidQty = 0): the oracle drops off the paid basis entirely
    // (`onPaidBasis = hasFreeUnits && paidQty > 0`) and prorates linearly over
    // orderQty — 1 free box of 24 on a 1-box line, stored $100, half delivered:
    // basisQty=24, billedThrough(12)=12, subtotal=round(100*12/24)=50.00.
    label: "box-split: free units cover the whole line (paidQty 0) -> linear fallback 50.00",
    storedSubtotal: 100,
    deliveredQty: 12,
    orderQty: 24,
    freeUnits: 1,
    freeUnitSize: 24,
    expected: 50.0,
  },
];

/**
 * `prorateLineSubtotal`'s DEFENSIVE and degenerate branches — the ones no
 * money-shaped row above ever reaches. Two of these rows are true mutation
 * detectors (the delivered-qty clamp and the absence of an ordered-qty clamp);
 * the other two are CONTRACT pins whose guard is belt-and-braces with
 * `roundMoney`'s own finite guard — worth stating because "an empty or
 * money-less line bills $0.00" is what the driver screen depends on, not
 * because removing one line of code would flip them.
 *
 * None of them is known-broken behavior, so they live in their own array
 * feeding an UNTOKENED describe (same policy as
 * NORMALIZE_BOXES_PIECES_FIXTURES — the red gate's `-t "REG-B(50|109|122)"`
 * must read only the counter-example set).
 */
export const PRORATE_EDGE_FIXTURES: ProrateLineSubtotalFixture[] = [
  {
    // `if (!(order > 0)) return 0` — a line with nothing ordered bills nothing.
    // Drop the guard and the basis is 0, so the quotient is Infinity; roundMoney's
    // finite guard would still land on 0, which is why this pins the CONTRACT at
    // the boundary rather than claiming to detect that one deletion.
    label: "orderQty 0 -> 0.00 (never a division by the empty basis)",
    storedSubtotal: 50,
    deliveredQty: 3,
    orderQty: 0,
    freeUnits: 0,
    expected: 0,
  },
  {
    // No stored money on the line (mobile passes `OrderItem.subtotal`, which is
    // nullable) — `Number(null) || 0` = 0, so the line contributes $0.00 rather
    // than NaN to the driver's running total. Also a contract pin: an `undefined`
    // subtotal would reach roundMoney as NaN and be absorbed there too, so what
    // this fixes in place is the OUTCOME the single implementation owes, on both signatures.
    label: "storedSubtotal null -> 0.00 (a line with no agreed money is free)",
    storedSubtotal: null,
    deliveredQty: 3,
    orderQty: 6,
    freeUnits: 0,
    expected: 0,
  },
  {
    // CONTRACT CHANGED DELIBERATELY at close-out (this pin fired exactly as
    // designed and the change was reviewed): the basisQty cap added for the
    // Fable final-pass major bounds EVERY billed share at the paid basis, so
    // over-delivery no longer extrapolates — the helper never bills above the
    // line's agreed stored subtotal. Callers still clamp (short-pick.ts does
    // `Math.min(raw, orderedQty)`), so this region stays unreachable in real
    // flows; genuine over-delivery is an order-EDIT concern, not proration.
    // The server oracle trusts its callers the same way, so no reachable
    // implementation-vs-oracle divergence exists inside delivered <= orderQty.
    label: "deliveredQty above orderQty is capped at the agreed subtotal: 9 of 6 -> 50.00",
    storedSubtotal: 50,
    deliveredQty: 9,
    orderQty: 6,
    freeUnits: 0,
    expected: 50.0,
  },
  {
    // `delivered = Math.max(0, ...)` — a negative delivered qty floors at zero.
    // Without that clamp this returns −25.00: a NEGATIVE at-door charge.
    label: "negative deliveredQty floors at 0 -> 0.00 (never a negative charge)",
    storedSubtotal: 50,
    deliveredQty: -3,
    orderQty: 6,
    freeUnits: 0,
    expected: 0,
  },
];

// ─── Tier ladder (R6 — no known divergence) ────────────────────────────────

export interface TierPriceableFixture {
  pricePerUnit?: number | string | null;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
}

export interface TierPriceFixture {
  label: string;
  product: TierPriceableFixture;
  tier: number;
  expected: number;
}

export const TIER_PRICE_FIXTURES: TierPriceFixture[] = [
  {
    label: "tier 1 always returns the list price",
    product: { pricePerUnit: 10 },
    tier: 1,
    expected: 10,
  },
  {
    label: "tier 2 uses its own column when set",
    product: { pricePerUnit: 10, priceTier2: 8.5 },
    tier: 2,
    expected: 8.5,
  },
  {
    label: "an unset (0) tier column inherits the list price, never $0.00",
    product: { pricePerUnit: 10, priceTier2: 0 },
    tier: 2,
    expected: 10,
  },
  {
    label: "tier 5 uses its own column",
    product: { pricePerUnit: 10, priceTier5: 6.25 },
    tier: 5,
    expected: 6.25,
  },
  {
    label: "an out-of-range tier falls back to the list price",
    product: { pricePerUnit: 12 },
    tier: 9,
    expected: 12,
  },
];

export type TierFieldFixture =
  "pricePerUnit" | "priceTier2" | "priceTier3" | "priceTier4" | "priceTier5";

export interface CascadeTierPriceFixture {
  label: string;
  field: TierFieldFixture;
  value: number;
  expected: Partial<Record<TierFieldFixture, string>>;
}

export const CASCADE_TIER_PRICE_FIXTURES: CascadeTierPriceFixture[] = [
  {
    label: "committing tier 2 cascades 2.00 down through tiers 3, 4 and 5",
    field: "priceTier2",
    value: 2,
    expected: { priceTier3: "2.00", priceTier4: "2.00", priceTier5: "2.00" },
  },
  // REG-B122 at the tier ladder: the thousandths digit is exactly 5, so
  // half-away-from-zero puts the cascaded string on the cent ABOVE — 2.135 -> "2.14",
  // the same value roundMoney returns. The integer rows above are blind to this
  // (they round identically under any policy), which is how an inlined
  // `+ Number.EPSILON` copy of the rounding survived here, writing "2.13" into
  // priceTier3/4/5 while every other money path billed 2.14.
  {
    label: "cascading a half-cent tier price rounds UP, matching roundMoney (REG-B122)",
    field: "priceTier2",
    value: 2.135,
    expected: { priceTier3: "2.14", priceTier4: "2.14", priceTier5: "2.14" },
  },
  {
    label: "committing tier 5 cascades nothing (bottom of the ladder)",
    field: "priceTier5",
    value: 3,
    expected: {},
  },
  {
    label: "committing tier 1 (list price) cascades nothing — index 0 is excluded",
    field: "pricePerUnit",
    value: 4,
    expected: {},
  },
];

// ─── normalizeBoxesPieces (currently correct — kept OUT of the red gate) ───

export interface NormalizeBoxesPiecesFixtureInput {
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  unitsPerBox?: number | null;
}

export interface NormalizeBoxesPiecesFixture {
  label: string;
  input: NormalizeBoxesPiecesFixtureInput;
  expected: { boxes: number | null; pieces: number | null; qty: number };
}

export const NORMALIZE_BOXES_PIECES_FIXTURES: NormalizeBoxesPiecesFixture[] = [
  {
    label: "rolls a full box of loose pieces up into boxes",
    input: { boxes: 1, pieces: 11, unitsPerBox: 11 },
    expected: { boxes: 2, pieces: 0, qty: 22 },
  },
  {
    label: "derives a boxes/pieces split from a raw piece qty",
    input: { qty: 23, unitsPerBox: 11 },
    expected: { boxes: 2, pieces: 1, qty: 23 },
  },
  {
    label: "non-boxed product coerces to an integer qty, clamped at zero",
    input: { qty: -5, unitsPerBox: 1 },
    expected: { boxes: null, pieces: null, qty: 0 },
  },
];
