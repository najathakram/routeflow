/**
 * T2 (R2, R7) — golden money table for @routeflow/pricing.
 *
 * Every `expected` value in `./golden.fixtures.ts` is hand-worked decimal
 * arithmetic — never read out of an implementation. The table was moved here
 * from api's former `pricing-parity.fixtures.ts` (deleted in the
 * @routeflow/pricing consolidation).
 *
 * Both the package under test and its fixture table are now PLAIN imports: the
 * red-gate scaffolding (guarded requires that read a missing module back as
 * `{}`) is gone now that `./index` and `./golden.fixtures` both exist, so a
 * rename, move or syntax error fails loudly instead of silently emptying this
 * table. The anti-vacuity block at the bottom is the second half of that guard:
 * a missing or empty fixture table fails rather than registering no test.
 */

import * as pricingModule from "./index";
import * as goldenFixtures from "./golden.fixtures";

type AnyRow = Record<string, any>;

const mod = pricingModule as unknown as Record<string, any>;
const fixtures = goldenFixtures as unknown as Record<string, any>;

/** Every fixture table this suite drives — asserted non-empty below so the golden
 * money table can never go silently vacuous. */
const FIXTURE_TABLE_NAMES = [
  "ROUND_MONEY_FIXTURES",
  "COMPUTE_LINE_SUBTOTAL_FIXTURES",
  "APPLY_BEST_PROMOTION_FIXTURES",
  "PRORATE_LINE_SUBTOTAL_FIXTURES",
  "PRORATE_EDGE_FIXTURES",
  "TIER_PRICE_FIXTURES",
  "CASCADE_TIER_PRICE_FIXTURES",
  "NORMALIZE_BOXES_PIECES_FIXTURES",
] as const;

/** Call a named export defensively: `undefined` (never a thrown TypeError) when the
 * package doesn't have it yet — a clean, real assertion mismatch against the fixture's
 * expected value, never an unresolvable-import or config failure. */
function callFn(name: string, ...args: unknown[]): unknown {
  const fn = mod[name];
  return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
}

/** Read a named fixture table defensively: `[]` (never a thrown "invalid it.each
 * variant") when the name is missing from `golden.fixtures.ts`. An empty result is
 * turned into a FAILING test by `itEachFixture` / the anti-vacuity block. */
function table(name: string): AnyRow[] {
  const rows = fixtures[name];
  return Array.isArray(rows) ? rows : [];
}

/**
 * `it.each` on an empty array THROWS ("`.each` called with an empty Array of
 * table data") — a Jest framework error, not an assertion mismatch. So an empty
 * or missing table registers ONE FAILING test instead: never zero tests, which
 * would let a rename in `golden.fixtures.ts` shrink the golden money table
 * while the suite still reported green. Once a table is populated, this is
 * exactly `it.each`.
 */
function itEachFixture(name: string, title: string, fn: (row: AnyRow) => void): void {
  const rows = table(name);
  if (rows.length === 0) {
    it(`${name} is non-empty`, () => {
      throw new Error(`${name} missing or empty in ./golden.fixtures`);
    });
    return;
  }
  it.each(rows)(title, fn);
}

describe("T2 — golden money table (R2, R7)", () => {
  describe("roundMoney — ROUND_MONEY_FIXTURES (REG-B122 half-away-from-zero)", () => {
    itEachFixture("ROUND_MONEY_FIXTURES", "golden: $label", (row: AnyRow) => {
      expect(callFn("roundMoney", row.input)).toBe(row.expected);
    });
  });

  describe("computeLineSubtotal — COMPUTE_LINE_SUBTOTAL_FIXTURES", () => {
    itEachFixture("COMPUTE_LINE_SUBTOTAL_FIXTURES", "golden: $label", (row: AnyRow) => {
      expect(callFn("computeLineSubtotal", row.input)).toBe(row.expected);
    });
  });

  describe("applyBestPromotion — APPLY_BEST_PROMOTION_FIXTURES (REG-B109)", () => {
    itEachFixture("APPLY_BEST_PROMOTION_FIXTURES", "golden: $label", (row: AnyRow) => {
      expect(callFn("applyBestPromotion", row.basePrice, row.promos, row.ctx)).toEqual(
        row.expected,
      );
    });
  });

  describe("prorateLineSubtotal — PRORATE_LINE_SUBTOTAL_FIXTURES (REG-B50)", () => {
    itEachFixture("PRORATE_LINE_SUBTOTAL_FIXTURES", "golden: $label", (row: AnyRow) => {
      expect(
        callFn(
          "prorateLineSubtotal",
          row.storedSubtotal,
          row.deliveredQty,
          row.orderQty,
          row.freeUnits,
          row.freeUnitSize ?? 1,
        ),
      ).toBe(row.expected);
    });
  });

  describe("prorateLineSubtotal — PRORATE_EDGE_FIXTURES (defensive/degenerate branches)", () => {
    itEachFixture("PRORATE_EDGE_FIXTURES", "golden: $label", (row: AnyRow) => {
      expect(
        callFn(
          "prorateLineSubtotal",
          row.storedSubtotal,
          row.deliveredQty,
          row.orderQty,
          row.freeUnits,
          row.freeUnitSize ?? 1,
        ),
      ).toBe(row.expected);
    });
  });

  describe("getTierPrice — TIER_PRICE_FIXTURES", () => {
    itEachFixture("TIER_PRICE_FIXTURES", "golden: $label", (row: AnyRow) => {
      expect(callFn("getTierPrice", row.product, row.tier)).toBe(row.expected);
    });
  });

  describe("cascadeTierPrices — CASCADE_TIER_PRICE_FIXTURES (REG-B122)", () => {
    itEachFixture("CASCADE_TIER_PRICE_FIXTURES", "golden: $label", (row: AnyRow) => {
      expect(callFn("cascadeTierPrices", row.field, row.value)).toEqual(row.expected);
    });
  });

  describe("normalizeBoxesPieces — NORMALIZE_BOXES_PIECES_FIXTURES", () => {
    itEachFixture("NORMALIZE_BOXES_PIECES_FIXTURES", "golden: $label", (row: AnyRow) => {
      expect(callFn("normalizeBoxesPieces", row.input)).toEqual(row.expected);
    });
  });

  // ── Explicit cases (not fixture-table-driven) ────────────────────────────

  describe("prorateLineSubtotal — null/undefined storedSubtotal (golden explicit case)", () => {
    it("golden: prorateLineSubtotal(null, 2, 4) -> 0", () => {
      expect(callFn("prorateLineSubtotal", null, 2, 4)).toBe(0);
    });

    it("golden: prorateLineSubtotal(undefined, 2, 4) -> 0", () => {
      expect(callFn("prorateLineSubtotal", undefined, 2, 4)).toBe(0);
    });
  });

  describe("effectiveQty (golden explicit case)", () => {
    it("golden: effectiveQty({ boxes: 2, pieces: 3 }, 12) -> 27", () => {
      expect(callFn("effectiveQty", { boxes: 2, pieces: 3 }, 12)).toBe(27);
    });

    it("golden: effectiveQty({ qty: 5 }, 12) -> 5", () => {
      expect(callFn("effectiveQty", { qty: 5 }, 12)).toBe(5);
    });
  });

  describe("roundUnitCost (golden explicit case)", () => {
    it("golden: roundUnitCost(1.23456) -> 1.2346", () => {
      expect(callFn("roundUnitCost", 1.23456)).toBe(1.2346);
    });
  });

  // ── Anti-vacuity ─────────────────────────────────────────────────────────
  // The golden table is the primary proof for R2 ("no pricing body may
  // change"). It must never be able to pass by executing nothing.

  describe("fixture tables are present (anti-vacuity)", () => {
    it.each(FIXTURE_TABLE_NAMES.map((name) => [name]))("%s has rows", (name: string) => {
      expect(table(name).length).toBeGreaterThan(0);
    });

    it("the package under test actually exports the money functions", () => {
      expect(typeof mod.roundMoney).toBe("function");
      expect(typeof mod.computeLineSubtotal).toBe("function");
      expect(typeof mod.getTierPrice).toBe("function");
      expect(typeof mod.normalizeBoxesPieces).toBe("function");
    });
  });
});
