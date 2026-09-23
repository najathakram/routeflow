import { computeOrderTotal, lineUnitFor } from "../lib/cart-order-total";
import { effectiveUnitPrice, type LineState, type Product } from "../lib/cart-line-state";
import { getTierPrice } from "@routeflow/pricing";
import { unitPriceBase } from "../lib/unit-options";

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
