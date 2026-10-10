import {
  computeOrderTotal,
  lineUnitFor,
  priceEditorPrefill,
  priceEditorSaveOverride,
} from "../lib/cart-order-total";
import { effectiveUnitPrice, type LineState, type Product } from "../lib/cart-line-state";
import { getTierPrice, resolveUnitPrice } from "@routeflow/pricing";
import { buildUnitOptions, unitPriceBase } from "../lib/unit-options";
import type { ProductUnitLevel } from "@routeflow/types";

/**
 * SA-085 pre-read requirement for #1264-v2 (c2caf627): "nothing executable pins" the
 * order-total fix — before this, the $24.00-footer-beside-a-$220.00-line bug was only proven
 * by Playwright captures. `lineUnitFor`/`computeOrderTotal` are lifted verbatim out of
 * NewOrderScreen.tsx (lib/cart-order-total.ts) so the component is a thin wrapper over these,
 * not a second implementation — these tests exercise the SAME code the screen renders from.
 *
 * Fixture values match the real capture: Case Sparkling Soda 24pk, pack price $24.00
 * (pricePerUnit), Case unit level $220.00 (240 pcs) — see
 * local-assets/proofs/mobile-unit-picker/.
 */

const product: Product = {
  id: "p1",
  name: "Case Sparkling Soda 24pk",
  pricePerUnit: "24.00",
  priceTier2: "25.00",
  unitsPerBox: 24,
};

function unitLine(overrides: Partial<LineState> = {}): LineState {
  return {
    qty: 1,
    unitLabel: "Case",
    unitBasePrice: 220,
    ...overrides,
  };
}

describe("lineUnitFor — the fixed derivation", () => {
  it("STANDARD tier (1), no override: prices a unit-sold line off its OWN resolved level (220), never the pack's tier price (24)", () => {
    expect(lineUnitFor(unitLine(), product, 1)).toBe(220);
  });

  it("a tier OTHER THAN 1 (SPECIAL/locked): still prices off the unit's own level, ignoring the pack's tier-2 price entirely", () => {
    expect(lineUnitFor(unitLine(), product, 2)).toBe(220);
  });

  it("a tier OTHER THAN 1 with a stray unitPrice present: SPECIAL locks the price, so the override is ignored — same 220", () => {
    expect(lineUnitFor(unitLine({ unitPrice: 999 }), product, 2)).toBe(220);
  });

  it("STANDARD tier (1) WITH a genuine operator override: the override wins over the unit's own base price", () => {
    expect(lineUnitFor(unitLine({ unitPrice: 200 }), product, 1)).toBe(200);
  });

  it("a plain (non-unit) line is unaffected — still the tier price, unchanged behaviour", () => {
    const plain: LineState = { qty: 1 };
    expect(lineUnitFor(plain, product, 1)).toBe(24);
    expect(lineUnitFor(plain, product, 2)).toBe(25);
  });
});

/**
 * SA-085i(b): the tray price-editor's pre-fill and Save-writes-an-override decision, lifted
 * into lib so a regression to `tierPriceFor(p)` (the shipped bug — a Case's pre-fill showed
 * $24, and Save then wrote it as a $24 DISCOUNTED override) fails a VALUE test, not just a
 * presence pin the screen could quietly stop calling.
 */
describe("priceEditorPrefill (SA-085i)", () => {
  it("a Case line's pre-fill is 220, never the pack's 24", () => {
    expect(priceEditorPrefill(unitLine(), product, 1)).toBe(220);
    expect(priceEditorPrefill(unitLine(), product, 1)).not.toBe(24);
  });

  it("a plain pack line's pre-fill is unaffected — still the tier price", () => {
    expect(priceEditorPrefill({ qty: 1 }, product, 1)).toBe(24);
  });
});

describe("priceEditorSaveOverride (SA-085i)", () => {
  it("typed === base writes NO override (an untouched pre-fill must never become one)", () => {
    expect(priceEditorSaveOverride(220, 220)).toBeNull();
  });

  it("typed !== base writes the override, with base as the comparison point", () => {
    expect(priceEditorSaveOverride(200, 220)).toBe(200);
  });

  it("a clear (null) passes through unchanged", () => {
    expect(priceEditorSaveOverride(null, 220)).toBeNull();
  });
});

describe("computeOrderTotal — the footer/order-total memo's real implementation", () => {
  const tierForProduct = (id: string) => (id === "p1" ? 2 : 1);

  it("a tier≠1 unit-sold line: the footer equals what the server actually bills — qty (count) × the unit's own resolved price, never the pack's", () => {
    const items: Record<string, LineState> = { p1: unitLine({ qty: 2 }) };
    const productById = new Map([["p1", product]]);

    const { total, totalItems } = computeOrderTotal(items, productById, [], tierForProduct);

    // The server's own wire contract for a unit-sold line is {productId, qty: <count>,
    // unitLabel} — it bills exactly qty * that unit's resolved price. This IS that
    // computation, so agreement with it is definitional, not a coincidence to assert past.
    const serverTotal = 2 * 220;
    expect(total).toBe(serverTotal);
    expect(total).toBe(440);
    expect(totalItems).toBe(2); // the COUNT of Cases, never expanded to 480 pieces
  });

  it("the same tier≠1 unit line, now carrying a stray price override: the footer is unchanged (440) — SPECIAL locks the price", () => {
    const items: Record<string, LineState> = { p1: unitLine({ qty: 2, unitPrice: 999 }) };
    const productById = new Map([["p1", product]]);

    const { total } = computeOrderTotal(items, productById, [], tierForProduct);
    expect(total).toBe(440);
  });

  it("a tier=1 unit line WITH a genuine override: the footer reflects the override, not the unit's base price", () => {
    const items: Record<string, LineState> = { p1: unitLine({ qty: 3, unitPrice: 200 }) };
    const productById = new Map([["p1", product]]);

    const { total } = computeOrderTotal(items, productById, [], () => 1);
    expect(total).toBe(600); // 3 * 200, not 3 * 220
  });

  it("RED PROOF — reverting the fix reproduces the exact $24-beside-$220 bug this was built to catch", () => {
    // The OLD (buggy) derivation, verbatim: `isSpecial ? tierPrice : effectiveUnitPrice(line,
    // tierPrice)` — no unitPriceBase, no unitLabel awareness at all. This is what shipped
    // before SA-085/#1264-v2's fix; it must NOT agree with the correct total below.
    function oldBuggyLineUnitFor(line: LineState, p: Product, tier: number): number {
      const isSpecial = tier !== 1;
      const tierPrice = getTierPrice(p, tier);
      return isSpecial ? tierPrice : effectiveUnitPrice(line, tierPrice);
    }

    const line = unitLine({ qty: 1 }); // tier 1, no override — the exact captured scenario
    const oldTotal = oldBuggyLineUnitFor(line, product, 1);
    const newTotal = lineUnitFor(line, product, 1);

    expect(oldTotal).toBe(24); // the wrong footer this bug actually produced, captured live
    expect(newTotal).toBe(220); // the correct line total, agreeing with the cart row
    expect(oldTotal).not.toBe(newTotal);

    // And unitPriceBase is exactly the seam that closes the gap: feeding the OLD
    // derivation's tierPrice through it recovers the correct answer.
    expect(unitPriceBase(line, getTierPrice(product, 1))).toBe(220);
  });
});

describe("computeOrderTotal ties phone to server — not two hand-picked numbers agreeing by construction", () => {
  // Every test above hand-writes `unitBasePrice: 220` into the fixture, so a footer that
  // agrees with `qty * 220` is circular: both sides were chosen by the test author, never by
  // the real pricing code. The seam that can actually diverge is upstream of computeOrderTotal
  // entirely — `buildUnitOptions`'s own call to `resolveUnitPrice` when a picker option is
  // built. This test drives THAT function (the same one `setUnitLabel` calls when an operator
  // picks a unit) to get `unitBasePrice`, then checks it against `resolveUnitPrice` called
  // independently — the SAME function the server prices unit lines with
  // (apps/api/src/orders/unit-line-build.ts:266, re-exported from @routeflow/pricing) — so
  // agreement here is a real proof that phone and server would bill the same amount, not an
  // assertion against a number this file chose by hand.
  const CASE_LEVEL: ProductUnitLevel = {
    id: "case-1",
    label: "Case",
    factorToBase: 240,
    price: "220.00", // tier 1
    priceTier2: "200.00", // tier 2 — deliberately NOT the same as tier 1, so a tier mix-up shows
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
  };
  const tier = 2;

  it("RED — a plausible real bug (tier dropped, tier-1's Case price used at tier 2) disagrees with the server price", () => {
    const wrongUnitBasePrice = resolveUnitPrice(product, [CASE_LEVEL], "Case", 1); // 220, wrong tier
    const line: LineState = { qty: 3, unitLabel: "Case", unitBasePrice: wrongUnitBasePrice };
    const { total } = computeOrderTotal({ p1: line }, new Map([["p1", product]]), [], () => tier);

    const serverTotal = 3 * resolveUnitPrice(product, [CASE_LEVEL], "Case", tier); // 3 * 200 = 600
    expect(total).not.toBe(serverTotal); // 660 !== 600 — this is what a tier mix-up looks like
  });

  it("GREEN — unitBasePrice built the way setUnitLabel does (via buildUnitOptions) agrees with resolveUnitPrice at the customer's real tier", () => {
    const options = buildUnitOptions(product, [CASE_LEVEL], tier);
    const caseOption = options.find((o) => o.value === "Case");
    expect(caseOption).toBeDefined();

    // The exact assignment setUnitLabel makes when an operator picks this option (see
    // NewOrderScreen.tsx / edit-items.tsx's setUnitLabel: `unitBasePrice: option.price`).
    const line: LineState = { qty: 3, unitLabel: "Case", unitBasePrice: caseOption!.price };
    const { total } = computeOrderTotal({ p1: line }, new Map([["p1", product]]), [], () => tier);

    const serverTotal = 3 * resolveUnitPrice(product, [CASE_LEVEL], "Case", tier);
    expect(total).toBe(serverTotal);
    expect(total).toBe(600); // 3 * 200 — the tier-2 Case price, not tier-1's 220
  });
});
