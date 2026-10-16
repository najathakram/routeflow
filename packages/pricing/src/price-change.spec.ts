import {
  DEFAULT_TIER_RULES,
  buildLadderView,
  ladderPrice,
  priceSource,
  refForLabel,
  type LadderViewUnit,
  type PriceTier,
} from "./price-ladder";
import {
  applyCellPatches,
  planCellEdit,
  planPriceChange,
  scalePrice,
  type CellPatch,
} from "./price-change";
import { applyLadderChange } from "./tier-pricing";
import type { LadderProduct } from "./unit-levels";

const lvl = (
  label: string,
  factorToBase: number,
  price: string | null = null,
  extra: Record<string, unknown> = {},
): LadderViewUnit => ({
  label,
  factorToBase,
  price,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  ...extra,
});
const TIERS: PriceTier[] = [1, 2, 3, 4, 5];
const box: LadderProduct = {
  unit: "Box",
  unitsPerBox: 12,
  pricePerUnit: "12.00",
  priceTier2: "11.00",
};
const units = [lvl("Pallet", 5760, "2600.00"), lvl("Case", 72, "66.00")];
const R = (label: string) => refForLabel(box, units, label);
const setOf = (view: ReturnType<typeof buildLadderView>, ref: string, tier: PriceTier) =>
  view.rows.find((r) => r.ref === ref)!.set[tier - 1];
const at = (patches: CellPatch[], ref: string, tier: PriceTier) =>
  patches.find((p) => p.ref === ref && p.tier === tier)?.to;

describe("T8: raise by a percent", () => {
  it("Case set $66 raised 5% with 'also': Case $69.30, Box $12.60, Pallet $2,730.00, Box Tier 2 $11.55", () => {
    const view = buildLadderView(box, units);
    const plan = planPriceChange(view, {
      unit: R("Case"),
      direction: "raise",
      mode: "percent",
      value: 5,
      also: true,
    });
    expect(plan.problems).toEqual([]);
    expect(at(plan.patches, R("Case"), 1)).toBe(69.3);
    expect(at(plan.patches, "pack", 1)).toBe(12.6);
    expect(at(plan.patches, R("Pallet"), 1)).toBe(2730);
    expect(at(plan.patches, "pack", 2)).toBe(11.55);
    // Auto prices follow by the rules: the implicit Piece is Box / 12 at the new Box price.
    expect(plan.changes.find((c) => c.label === "Piece" && c.tier === 1)).toMatchObject({
      from: 1,
      to: 1.05,
    });
  });

  it("without 'also' only the picked unit's Retail moves; the other set prices stay", () => {
    const view = buildLadderView(box, units);
    const plan = planPriceChange(view, {
      unit: R("Case"),
      direction: "raise",
      mode: "percent",
      value: 5,
    });
    expect(plan.patches).toEqual([{ ref: R("Case"), tier: 1, to: 69.3 }]);
  });

  it("an Auto Retail moves too and becomes Set at the new value; lowering works", () => {
    const view = buildLadderView(box, []);
    const piece = refForLabel(box, [], "Piece");
    const plan = planPriceChange(view, {
      unit: piece,
      direction: "lower",
      mode: "percent",
      value: 10,
    });
    expect(plan.patches).toEqual([{ ref: piece, tier: 1, to: 0.9 }]);
    expect(plan.undo).toEqual([{ ref: piece, tier: 1, to: null }]);
    expect(
      priceSource(
        plan.view.rows.find((r) => r.ref === piece)!,
        1,
      ),
    ).toBe("set");
  });

  it("PF-4: an Auto Piece of a $10 Box of 12 raised 3% is rounded once: $0.86, not $0.85", () => {
    const p: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "10.00" };
    const view = buildLadderView(p, []);
    const piece = refForLabel(p, [], "Piece");
    expect(ladderPrice(view, piece, 1)).toBe(0.83); // the shown price; the exact one is 0.8333
    const plan = planPriceChange(view, {
      unit: piece,
      direction: "raise",
      mode: "percent",
      value: 3,
    });
    expect(plan.patches).toEqual([{ ref: piece, tier: 1, to: 0.86 }]);
  });
});

describe("T9: raise by an amount", () => {
  it("Box +$1 with 'also': Case set $66 -> $72.00 (same amount per piece), Box Tier 2 set $11 -> $12.00", () => {
    const view = buildLadderView(box, units);
    const plan = planPriceChange(view, {
      unit: "pack",
      direction: "raise",
      mode: "amount",
      value: 1,
      also: true,
    });
    expect(at(plan.patches, "pack", 1)).toBe(13);
    expect(at(plan.patches, R("Case"), 1)).toBe(72);
    expect(at(plan.patches, "pack", 2)).toBe(12);
    expect(at(plan.patches, R("Pallet"), 1)).toBe(3080); // 2,600 + 1 x 5,760 / 12
  });

  it("without 'also' Box +$1 moves the Box Retail only", () => {
    const plan = planPriceChange(buildLadderView(box, units), {
      unit: "pack",
      direction: "raise",
      mode: "amount",
      value: 1,
    });
    expect(plan.patches).toEqual([{ ref: "pack", tier: 1, to: 13 }]);
  });
});

describe("refusals", () => {
  it("a change that would reach $0.00 or an unreadable amount writes nothing and says why", () => {
    const view = buildLadderView(box, units);
    const tooMuch = planPriceChange(view, {
      unit: "pack",
      direction: "lower",
      mode: "amount",
      value: 12,
    });
    expect(tooMuch.patches).toEqual([]);
    expect(tooMuch.problems[0]).toMatch(/\$0\.00/);
    for (const value of [0, -1, NaN]) {
      const p = planPriceChange(view, { unit: "pack", direction: "raise", mode: "percent", value });
      expect(p.patches).toEqual([]);
      expect(p.problems.length).toBe(1);
    }
    const all = planPriceChange(view, {
      unit: "pack",
      direction: "lower",
      mode: "percent",
      value: 100,
    });
    expect(all.patches).toEqual([]);
    expect(
      planPriceChange(view, { unit: "nope", direction: "raise", mode: "percent", value: 5 })
        .problems.length,
    ).toBe(1);
  });
});

describe("T11: undo restores the previous set values exactly", () => {
  it("apply then undo gives the original grid, set cells and Auto cells alike", () => {
    const view = buildLadderView(box, units);
    const plan = planPriceChange(view, {
      unit: R("Case"),
      direction: "raise",
      mode: "percent",
      value: 5,
      also: true,
    });
    const back = applyCellPatches(plan.view, plan.undo).view;
    expect(back.rows).toEqual(view.rows);
    expect(back.anchor).toBe(view.anchor);
  });
});

describe("T10: typing a cell sets that cell only", () => {
  const retail20: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "20.00" };

  it("master copies Tier 3 = 18 into the empty Tiers 4 and 5; the cell edit writes nothing else and offers it", () => {
    // Observed on master: the ladder rule writes $18.00 into both empty tiers below.
    expect(applyLadderChange("priceTier3", null, "18", { priceTier4: 0, priceTier5: 0 })).toEqual({
      priceTier4: "18.00",
      priceTier5: "18.00",
    });
    const view = buildLadderView(retail20, []);
    const plan = planCellEdit(view, "pack", 3, "18");
    expect(plan.patches).toEqual([{ ref: "pack", tier: 3, to: 18 }]);
    expect(plan.offers).toHaveLength(1);
    expect(plan.offers[0]).toMatchObject({
      ref: "pack",
      tiers: [4, 5],
      value: 18,
      title: "Set Tier 4 and Tier 5 to $18.00 too",
    });
    expect(plan.offers[0].warning).toBe("Tier 4 and Tier 5 are higher than Tier 3 ($18.00).");
    // One click applies the offer; it is its own undoable patch.
    const after = applyCellPatches(plan.view, plan.offers[0].patches).view;
    expect(setOf(after, "pack", 4)).toBe(18);
    expect(setOf(after, "pack", 5)).toBe(18);
  });

  it("PF-2: retyping Tier 2 lower still offers the Auto tiers above it, even if they were over its old price", () => {
    const p: LadderProduct = { ...retail20, pricePerUnit: "12.00", priceTier2: "11.00" };
    const plan = planCellEdit(buildLadderView(p, []), "pack", 2, "10.50");
    expect(plan.offers).toHaveLength(1);
    expect(plan.offers[0]).toMatchObject({ ref: "pack", tiers: [3, 4, 5], value: 10.5 });
  });

  it("no offer when the tiers below are already at or under the typed price, or are set", () => {
    const set: LadderProduct = { ...retail20, priceTier4: "15.00", priceTier5: "14.00" };
    expect(planCellEdit(buildLadderView(set, []), "pack", 3, "18").offers).toEqual([]);
    const mixed: LadderProduct = { ...retail20, priceTier4: "19.00" };
    // Tier 4 is set (the owner's choice): the offer stops there, so Tier 5 is not offered either.
    expect(planCellEdit(buildLadderView(mixed, []), "pack", 3, "18").offers).toEqual([]);
  });

  it("clearing a cell makes it Auto again; the unit the others are worked out from cannot lose its Retail", () => {
    const view = buildLadderView(box, units);
    const clear = planCellEdit(view, R("Case"), 1, "");
    expect(clear.patches).toEqual([{ ref: R("Case"), tier: 1, to: null }]);
    expect(clear.undo).toEqual([{ ref: R("Case"), tier: 1, to: 66 }]);
    const anchor = planCellEdit(view, "pack", 1, "");
    expect(anchor.patches).toEqual([]);
    expect(anchor.problems[0]).toMatch(/worked out from/);
  });

  it("P6: zero and junk are refused with the message; a price is rounded to cents", () => {
    const view = buildLadderView(box, units);
    expect(planCellEdit(view, R("Case"), 2, "0").problems[0]).toMatch(/above \$0\.00/);
    expect(planCellEdit(view, R("Case"), 2, "0").patches).toEqual([]);
    expect(planCellEdit(view, R("Case"), 2, "61.239").patches).toEqual([
      { ref: R("Case"), tier: 2, to: 61.24 },
    ]);
  });
});

describe("scalePrice (the one rounding for a proportional move)", () => {
  it("is roundMoney(from x num / den) and agrees with web's proposeCascade arithmetic", () => {
    expect(scalePrice(480, 40, 42)).toBe(457.14);
    expect(scalePrice(450, 36, 40)).toBe(405);
    expect(scalePrice(66, 105, 100)).toBe(69.3);
  });
});

describe("the grid after a change still follows the rules", () => {
  it("a Box raise moves the Auto Case and Piece prices that are worked out from it", () => {
    const only = [lvl("Case", 72)];
    const view = buildLadderView({ unit: "Box", unitsPerBox: 12, pricePerUnit: "12.00" }, only);
    const plan = planPriceChange(view, {
      unit: "pack",
      direction: "raise",
      mode: "percent",
      value: 50,
    });
    const caseRef = refForLabel(box, only, "Case");
    expect(ladderPrice(plan.view, caseRef, 1, DEFAULT_TIER_RULES)).toBe(108);
    expect(plan.changes.filter((c) => c.tier === 1).map((c) => [c.label, c.from, c.to])).toEqual([
      ["Case", 72, 108],
      ["Box", 12, 18],
      ["Piece", 1, 1.5],
    ]);
    expect(TIERS.length).toBe(5);
  });
});
