import {
  applyCellPatches,
  buildLadderView,
  planPriceChange,
  type LadderProduct,
} from "@routeflow/pricing";
import { againstReason, movesAgainst } from "./against-reason";

// K11-17 / row 600: proves the staging in e2e/k11-l2-against-reason.spec.ts on fixture E2E-FIX-UNITS
// (apps/api/scripts/e2e-seed.js): the product is the Piece at $2.00 (a one-piece pack), one Case x12 unit at $21.00.
// Same pricing functions the draft and the panel run; the E2E only adds the browser.
const product = { unit: "Piece", unitsPerBox: 1, pricePerUnit: "2.00" };
const caseUnit = {
  label: "Case",
  factorToBase: 12,
  price: "21.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};
const served = buildLadderView(product as LadderProduct, [{ ...caseUnit, id: "u-case" }]);
const tierName = (t: number) => (t === 1 ? "Retail" : `Tier ${t}`);

const raise = (patches: Parameters<typeof applyCellPatches>[1], unitLabel: string) => {
  const view = applyCellPatches(served, patches).view;
  const unit = view.rows.find((r) => r.label === unitLabel)!.ref;
  const plan = planPriceChange(view, { unit, direction: "raise", mode: "percent", value: 5 }, {});
  return { view, plan, against: plan.changes.filter((c) => movesAgainst("raise", c)) };
};

describe("E2E-FIX-UNITS: the staging the spec uses makes a row fall on a Raise", () => {
  it("fixture shape: Case first, Piece (the pack) last, anchor Piece", () => {
    expect(served.rows.map((r) => r.label)).toEqual(["Case", "Piece"]);
    expect(served.anchor).toBe("pack");
  });

  it("old staging (Case Tier 2 and Piece Retail, Raise Case) cannot fall: Auto Tier 2 follows the Piece", () => {
    const { against } = raise(
      [
        { ref: "u-case", tier: 2, to: 1000 },
        { ref: "pack", tier: 1, to: 5 },
      ],
      "Case",
    );
    expect(against).toEqual([]);
  });

  it("new staging (Piece Tier 2 $1.50, Raise Piece 5%): the Case's Auto Tier 2 falls, with a reason", () => {
    const { plan, against } = raise([{ ref: "pack", tier: 2, to: 1.5 }], "Piece");
    expect(against.length).toBeGreaterThan(0);
    const c = against.find((x) => x.ref === "u-case" && x.tier === 2)!;
    expect(c.to).toBeLessThan(c.from);
    expect(
      againstReason({
        view: applyCellPatches(served, [{ ref: "pack", tier: 2, to: 1.5 }]).view,
        rules: {},
        plan,
        change: c,
        direction: "raise",
        also: false,
        tierName,
      }),
    ).toMatch(/^Follows .+, which you set\./);
  });
});
