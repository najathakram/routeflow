import { buildLadderView, refForLabel, type LadderViewUnit } from "./price-ladder";
import { customerPrice, type CustomerPricingWithId } from "./price-anchor";
import { applyCellPatches, planCellEdit, planPriceChange, type PriceChange } from "./price-change";
import type { LadderProduct } from "./unit-levels";

// S2b (SA-798 G4 red rows, SA-799 one PricePlan type). Product "Cool Mint": Case = 10 Rolls = 50 Cans; the Roll anchor is
// $6.00 and the Can Retail is set at $1.25; Wholesale (tier 2) takes 8% off. The customer "acme" is Wholesale, orders by the
// Case and has the Case set at $54.00.

const lvl = (label: string, factorToBase: number, price: string | null): LadderViewUnit => ({
  label,
  factorToBase,
  price,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
});
const product: LadderProduct = { unit: "Case", unitsPerBox: 50, pricePerUnit: "60.00" };
const units = [lvl("Roll", 5, "6.00"), lvl("Can", 1, "1.25")];
const roll = refForLabel(product, units, "Roll");
const can = refForLabel(product, units, "Can");
const view = buildLadderView(product, units, { orderUnit: roll, packAuto: 1 });
const rules = { 2: 8 } as const;
const acme: CustomerPricingWithId = {
  customerId: "acme",
  tier: 2,
  orderUnit: "pack",
  set: { pack: 54 },
};
const rollPlus5: PriceChange = { unit: roll, direction: "raise", mode: "percent", value: 5 };
const plan = (change: PriceChange, customers: CustomerPricingWithId[] = [acme]) =>
  planPriceChange(view, change, rules, undefined, { customers });

describe("S2b: the fixture is the SA-798 arithmetic", () => {
  it("Case Wholesale $55.20 (Auto), Can Wholesale $1.15, acme's Can $1.13 before any change", () => {
    expect(customerPrice(view, "pack", { tier: 2 }, rules)).toBe(55.2);
    expect(customerPrice(view, can, { tier: 2 }, rules)).toBe(1.15);
    expect(customerPrice(view, can, acme, rules)).toBe(1.13);
  });
});

describe("S2b G4 red rows: customerChanges", () => {
  it("Roll +5% (also off) gives ONE acme Can row, against, cause shape: $1.13 -> $1.07", () => {
    expect(plan(rollPlus5).customerChanges).toEqual([
      {
        customerId: "acme",
        ref: can,
        tier: 2,
        from: 1.13,
        to: 1.07,
        against: true,
        cause: "shape",
      },
    ]);
  });

  it("Roll +5% with 'also' on gives cause rounding: $1.13 -> $1.12", () => {
    expect(plan({ ...rollPlus5, also: true }).customerChanges).toEqual([
      {
        customerId: "acme",
        ref: can,
        tier: 2,
        from: 1.13,
        to: 1.12,
        against: true,
        cause: "rounding",
      },
    ]);
  });

  it("no customers = today: an empty list and no customer offer", () => {
    const none = planPriceChange(view, rollPlus5, rules);
    expect(none.customerChanges).toEqual([]);
    expect(none.offers.filter((o) => o.kind === "customer")).toEqual([]);
    expect(plan(rollPlus5, []).customerChanges).toEqual([]);
  });

  it("a change that leaves the customer's prices alone lists nothing; a move of 0 is never against", () => {
    const lower: PriceChange = { unit: roll, direction: "lower", mode: "percent", value: 5 };
    const rows = plan(lower).customerChanges;
    expect(rows).toHaveLength(1);
    // Lowering the Roll: acme's Can moves UP ($1.13 -> $1.20), against a lower.
    expect(rows[0]).toMatchObject({ ref: can, from: 1.13, against: true, cause: "shape" });
    expect(rows[0].to).toBeGreaterThan(rows[0].from);
    const plain = planPriceChange(view, rollPlus5, rules, undefined, {
      customers: [{ customerId: "list", tier: 1 }],
    });
    expect(plain.customerChanges.length).toBeGreaterThan(0);
    expect(plain.customerChanges.every((r) => r.against === false)).toBe(true);
  });

  it("rows that follow the change are listed with against false", () => {
    const rows = plan(rollPlus5, [{ customerId: "plain", tier: 2 }]).customerChanges;
    const caseRow = rows.find((r) => r.ref === "pack");
    expect(caseRow).toMatchObject({ from: 55.2, to: 57.96, against: false, cause: "shape" });
  });
});

describe("S2b G4 red row (c): the opt-in customer move", () => {
  it("moves acme's Case to $56.70 by the tier ratio and the Can stays $1.13; never pre-selected", () => {
    const p = plan(rollPlus5);
    const offer = p.offers.find((o) => o.kind === "customer");
    expect(offer).toBeDefined();
    if (offer?.kind !== "customer") throw new Error("customer offer expected");
    expect(offer.ticked).toBe(false);
    expect(offer.moves).toEqual([{ customerId: "acme", ref: "pack", tier: 2, from: 54, to: 56.7 }]);
    const moved: CustomerPricingWithId = { ...acme, set: { pack: offer.moves[0].to } };
    expect(customerPrice(p.view, "pack", moved, rules)).toBe(56.7);
    expect(customerPrice(p.view, can, moved, rules)).toBe(1.13);
  });

  it("a move that rounds to $0.00, or leaves the price as it is, is not offered; a normal customer in the same call still is", () => {
    const tiny: CustomerPricingWithId = {
      customerId: "tiny",
      tier: 2,
      orderUnit: "pack",
      set: { pack: 0.004 }, // 0.004 x 57.96 / 55.20 rounds to $0.00
    };
    // The Can Retail is set and does not move, so this Retail customer's Can ratio is 1: the price would not change.
    const same: CustomerPricingWithId = { customerId: "same", tier: 1, set: { [can]: 2 } };
    const offer = plan(rollPlus5, [tiny, same, acme]).offers.find((o) => o.kind === "customer");
    if (offer?.kind !== "customer") throw new Error("customer offer expected");
    expect(offer.moves.map((m) => m.customerId)).toEqual(["acme"]);
    expect(plan(rollPlus5, [tiny, same]).offers.filter((o) => o.kind === "customer")).toEqual([]);
  });
});

describe("S2b SA-799: one PricePlan from both planners", () => {
  it("offers are never ticked; tier offers carry kind tier", () => {
    const edit = planCellEdit(
      buildLadderView({ ...product, priceTier2: "50.00" }, []),
      "pack",
      2,
      "40",
    );
    expect(edit.offers.length).toBeGreaterThan(0);
    for (const o of edit.offers) expect(o.ticked).toBe(false);
    expect(edit.offers[0].kind).toBe("tier");
  });

  it("planCellEdit returns followers (Auto cells that move) with a P7 Keep, and an empty customerChanges", () => {
    const edit = planCellEdit(view, roll, 1, "7", rules);
    expect(edit.customerChanges).toEqual([]);
    const caseRetail = edit.followers.find((f) => f.ref === "pack" && f.tier === 1);
    expect(caseRetail).toMatchObject({
      from: 60,
      to: 70,
      keep: { ref: "pack", tier: 1, value: 60 },
    });
    expect(edit.followers.some((f) => f.ref === roll && f.tier === 1)).toBe(false); // the typed cell is a patch
  });

  it("planPriceChange followers are the Auto cells that move; the patched cells are not followers", () => {
    const p = plan(rollPlus5);
    expect(p.patches.map((x) => `${x.ref}|${x.tier}`)).toEqual([`${roll}|1`]);
    expect(p.followers.every((f) => !(f.ref === roll && f.tier === 1))).toBe(true);
    expect(p.followers.find((f) => f.ref === "pack" && f.tier === 2)).toMatchObject({
      from: 55.2,
      to: 57.96,
      keep: { ref: "pack", tier: 2, value: 55.2 },
    });
    // The undo and the applied view are the same objects as before the refactor.
    expect(applyCellPatches(view, p.patches).view).toEqual(p.view);
  });

  it("a refused plan returns the full shape, empty", () => {
    const refused = planPriceChange(view, { ...rollPlus5, value: 0 }, rules);
    expect(refused).toMatchObject({
      patches: [],
      followers: [],
      offers: [],
      customerChanges: [],
    });
    expect(refused.problems).toHaveLength(1);
  });
});
