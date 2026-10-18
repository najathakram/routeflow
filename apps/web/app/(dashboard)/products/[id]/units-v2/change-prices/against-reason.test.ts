import { buildLadderView, planPriceChange, type LadderProduct } from "@routeflow/pricing";
import { againstReason, movesAgainst, NO_REASON } from "./against-reason";

// K11-17. The K9 fixture: Case $30.00 / Tier 2 $28.00 (both set), Piece Retail set $1.50, Piece Tier 2 Auto $1.40.
const product = { unit: "Case", unitsPerBox: 24, pricePerUnit: "30.00", priceTier2: "28.00" };
const piece = {
  label: "Piece",
  factorToBase: 1,
  price: "1.50",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};
const view = buildLadderView(product as LadderProduct, [piece]);
const tierName = (t: number) => (t === 1 ? "Retail" : `Tier ${t}`);
const plan = (direction: "raise" | "lower", value = 5, also = false) =>
  planPriceChange(view, { unit: "pack", direction, mode: "percent", value, also });

describe("movesAgainst", () => {
  it("is a lower price on a Raise and a higher price on a Lower", () => {
    expect(movesAgainst("raise", { from: 1.4, to: 1.33 })).toBe(true);
    expect(movesAgainst("raise", { from: 1.4, to: 1.5 })).toBe(false);
    expect(movesAgainst("lower", { from: 1.4, to: 1.5 })).toBe(true);
    expect(movesAgainst("lower", { from: 1.4, to: 1.33 })).toBe(false);
  });
});

describe("againstReason", () => {
  const p = plan("raise");
  const t2 = p.changes.find((c) => c.ref === "base" && c.tier === 2)!;

  it("names the Set price the row follows and how to move it", () => {
    expect(
      againstReason({
        view,
        rules: {},
        plan: p,
        change: t2,
        direction: "raise",
        also: false,
        tierName,
      }),
    ).toBe(
      'Follows Retail Piece $1.50, which you set. Tick "Also raise the prices you set" to move it.',
    );
  });

  it("says Lower for a Lower, and leaves the tick advice out when Also is already ticked", () => {
    const low = plan("lower");
    const up = low.changes.find((c) => c.to > c.from)!;
    expect(
      againstReason({
        view,
        rules: {},
        plan: low,
        change: up,
        direction: "lower",
        also: false,
        tierName,
      }),
    ).toContain('Tick "Also lower the prices you set"');
    expect(
      againstReason({
        view,
        rules: {},
        plan: low,
        change: up,
        direction: "lower",
        also: true,
        tierName,
      }),
    ).not.toContain("Tick");
  });

  it("falls back to the plain sentence when no source can be derived", () => {
    const stray = { ref: "base", label: "Piece", tier: 4 as const, from: 9.99, to: 9.5 };
    expect(
      againstReason({
        view,
        rules: {},
        plan: p,
        change: stray,
        direction: "raise",
        also: false,
        tierName,
      }),
    ).toBe(NO_REASON);
    expect(NO_REASON).toBe("This price follows another price that is not moving.");
  });

  it("property: every row that goes the wrong way on this ladder gets a non-empty reason", () => {
    let against = 0;
    for (const unit of ["pack", "base"]) {
      for (const direction of ["raise", "lower"] as const) {
        for (const value of [1, 5, 12.5, 40]) {
          for (const also of [false, true]) {
            const pl = planPriceChange(view, { unit, direction, mode: "percent", value, also });
            for (const c of pl.changes.filter((x) => movesAgainst(direction, x))) {
              against++;
              expect(
                againstReason({ view, rules: {}, plan: pl, change: c, direction, also, tierName })
                  .length,
              ).toBeGreaterThan(0);
            }
          }
        }
      }
    }
    expect(against).toBeGreaterThan(0);
  });
});
