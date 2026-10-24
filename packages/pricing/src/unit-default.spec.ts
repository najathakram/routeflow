import { buildLadderView, refForLabel, type LadderViewUnit } from "./price-ladder";
import { resolveInvoiceUnit, resolveUnitDefault, type UnitScopes } from "./unit-default";
import { defaultSellLevel } from "./sell-level";
import type { LadderProduct } from "./unit-levels";

const lvl = (label: string, factorToBase: number, id?: string): LadderViewUnit => ({
  label,
  factorToBase,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  ...(id ? { id } : {}),
});
const product: LadderProduct = { unit: "Box", unitsPerBox: 24, pricePerUnit: "18.90" };
const units = [lvl("Case", 144, "u-case"), lvl("Piece", 1, "u-piece")];
const view = buildLadderView(product, units);
const scopeNames = ["customer", "tier", "product", "business"] as const;

describe("T21: precedence is customer > tier > product > business, and the anchor comes back with the order unit", () => {
  // 16 combinations of which scopes hold a value. Each scope's value is a different unit.
  const value: Record<(typeof scopeNames)[number], string> = {
    customer: "base",
    tier: "u-case",
    product: "pack",
    business: "smallest",
  };
  const unitOf: Record<(typeof scopeNames)[number], string> = {
    customer: "base",
    tier: "u-case",
    product: "pack",
    business: "base",
  };
  for (let mask = 0; mask < 16; mask++) {
    const present = scopeNames.filter((_, i) => (mask >> i) & 1);
    it(`scopes set: ${present.join("+") || "none"}`, () => {
      const scopes: UnitScopes = {};
      for (const s of present) scopes[s] = value[s];
      const r = resolveUnitDefault(view, scopes);
      const winner = present[0];
      if (!winner) {
        expect(r).toMatchObject({ orderUnit: "pack", anchor: { unit: "pack", scope: "fallback" } });
      } else {
        expect(r.orderUnit).toBe(unitOf[winner]);
        expect(r.anchor).toEqual({ unit: unitOf[winner], scope: winner });
      }
    });
  }
});

describe("T22: a unit ref that is gone is skipped, the next scope wins", () => {
  it("a deleted customer unit falls to the tier; unknown everywhere falls to the pack", () => {
    expect(resolveUnitDefault(view, { customer: "u-deleted", tier: "u-case" }).anchor).toEqual({
      unit: "u-case",
      scope: "tier",
    });
    const none = resolveUnitDefault(view, { customer: "u-x", tier: "u-y", product: "u-z" });
    expect(none).toMatchObject({ orderUnit: "pack", anchor: { scope: "fallback" } });
    expect(none.skipped.map((s) => s.scope)).toEqual(["customer", "tier", "product"]);
  });

  it("a named business unit that the product lacks falls back to the pack for orders", () => {
    expect(resolveUnitDefault(view, { business: "Pallet" }).orderUnit).toBe("pack");
  });

  it("words: pack, smallest, a unit by id or by name (any case)", () => {
    expect(resolveUnitDefault(view, { product: "smallest" }).orderUnit).toBe("base");
    expect(resolveUnitDefault(view, { product: "case" }).orderUnit).toBe("u-case");
    expect(resolveUnitDefault(view, { product: "BOX" }).orderUnit).toBe("pack");
    expect(resolveUnitDefault(view, { product: "" }).orderUnit).toBe("pack");
  });
});

describe("T23: a shared scan code under a customer whose order unit is the Piece", () => {
  it("master picks the Box (defaultSellLevel); the resolver picks the customer's Piece", () => {
    expect(defaultSellLevel(product)).toBe("BOX"); // observed on master
    const r = resolveUnitDefault(view, { customer: refForLabel(product, units, "Piece") });
    expect(r.orderUnit).toBe("base");
    expect(r.label).toBe("Piece");
  });
});

describe("the invoice unit (owner requirement 12)", () => {
  it("legacy and ordered are modes, not units; smallest is the Piece; a missing named unit falls to the smallest", () => {
    expect(resolveInvoiceUnit(view, { business: "legacy" })).toMatchObject({ mode: "legacy" });
    expect(resolveInvoiceUnit(view, { product: "ordered" })).toMatchObject({ mode: "ordered" });
    expect(resolveInvoiceUnit(view, { business: "smallest" })).toMatchObject({
      mode: "unit",
      unit: "base",
      label: "Piece",
    });
    expect(resolveInvoiceUnit(view, { business: "Pallet" })).toMatchObject({
      mode: "unit",
      unit: "base",
    });
    expect(resolveInvoiceUnit(view, {})).toMatchObject({ mode: "legacy" }); // nothing set: today's behaviour
  });

  it("customer beats tier beats product beats business, like the order unit", () => {
    const r = resolveInvoiceUnit(view, {
      customer: "pack",
      tier: "u-case",
      product: "smallest",
      business: "legacy",
    });
    expect(r).toMatchObject({ mode: "unit", unit: "pack", scope: "customer" });
    expect(resolveInvoiceUnit(view, { tier: "u-case", business: "legacy" })).toMatchObject({
      unit: "u-case",
      scope: "tier",
    });
  });

  it("a one-piece pack has a single unit, so smallest is the pack", () => {
    const single = buildLadderView({ unit: "Each", unitsPerBox: 1, pricePerUnit: "3" }, []);
    expect(resolveInvoiceUnit(single, { business: "smallest" })).toMatchObject({ unit: "pack" });
  });
});
