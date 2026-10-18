import { getTierPrice } from "./tier-pricing";
import { buildLadderView, refForLabel, type LadderViewUnit } from "./price-ladder";
import {
  customerLayerPrice,
  customerTierFor,
  isSpecialPrice,
  resolveCustomerUnitPrice,
} from "./customer-unit-price";
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
const box12: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "12.00" };

describe("customerTierFor (the 16 readers' one rule)", () => {
  it("the customer-product tier, else the customer's tier, else 1; junk is 1", () => {
    expect(customerTierFor(3, 2)).toBe(3);
    expect(customerTierFor(null, 2)).toBe(2);
    expect(customerTierFor(undefined, undefined)).toBe(1);
    expect(customerTierFor("4", null)).toBe(4);
    expect(customerTierFor(9, 7)).toBe(1);
  });
});

describe("PF-14: customerTierFor against master for tiers outside 1 to 5", () => {
  const p = { pricePerUnit: "12.00", priceTier2: "11.00" };

  it("master reads a tier of 0 or 9 as the list price; with no valid tier to fall back on, so does the core", () => {
    expect(getTierPrice(p, 0)).toBe(12);
    expect(getTierPrice(p, 9)).toBe(12);
    expect(customerTierFor(0, null)).toBe(1);
    expect(customerTierFor(9, undefined)).toBe(1);
  });

  it("the one named difference: a junk customer-product tier falls through to the customer's own valid tier (master reads the list price)", () => {
    expect(customerTierFor(0, 2)).toBe(2);
    expect(customerTierFor(9, 2)).toBe(2);
    expect(getTierPrice(p, customerTierFor(9, 2))).toBe(11);
  });
});

describe("resolveCustomerUnitPrice", () => {
  it("T24: a customer with Box set $10 who orders by the Box pays $1.00 for a Piece whose Retail is $1.20", () => {
    const units = [lvl("Piece", 1, "1.20")];
    const piece = refForLabel(box12, units, "Piece");
    const r = resolveCustomerUnitPrice({
      product: box12,
      units,
      customer: { tier: 1, orderUnit: "pack", unitPrices: { pack: 10 } },
      unit: piece,
    });
    expect(r).toMatchObject({ price: 1, source: "customer-shape", unit: piece });
  });

  it("T24a: a customer who orders by the Case and has Case set $60: Box $10.00, Piece $0.83", () => {
    const units = [lvl("Case", 72)];
    const caseRef = refForLabel(box12, units, "Case");
    const customer = { tier: 1 as const, orderUnit: caseRef, unitPrices: { [caseRef]: 60 } };
    expect(resolveCustomerUnitPrice({ product: box12, units, customer, unit: "pack" }).price).toBe(
      10,
    );
    expect(resolveCustomerUnitPrice({ product: box12, units, customer, unit: "Piece" }).price).toBe(
      0.83,
    );
    expect(
      resolveCustomerUnitPrice({ product: box12, units, customer, unit: caseRef }).source,
    ).toBe("customer");
  });

  it("T24d (fold A1): a tier-2 customer keeps the tier's own shape: Piece $0.86, not $1.00", () => {
    const p: LadderProduct = { ...box12, priceTier2: "11.00" };
    const units = [lvl("Piece", 1, "1.20", { priceTier2: "0.95" })];
    const r = resolveCustomerUnitPrice({
      product: p,
      units,
      customer: { tier: 2, orderUnit: "pack", unitPrices: { pack: 10 } },
      unit: "Piece",
    });
    expect(r.price).toBe(0.86);
  });

  it("with nothing special the price is the plain tier price, and the source says so", () => {
    const p: LadderProduct = { ...box12, priceTier2: "11.00" };
    expect(
      resolveCustomerUnitPrice({ product: p, units: [], customer: { tier: 1 }, unit: "Box" }),
    ).toMatchObject({
      price: 12,
      source: "list",
    });
    expect(
      resolveCustomerUnitPrice({ product: p, units: [], customer: { tier: 2 }, unit: "Box" }),
    ).toMatchObject({
      price: 11,
      source: "tier",
    });
  });

  it("business tier rules flow through (8% on Tier 2, Box Tier 2 Auto: $11.04)", () => {
    const r = resolveCustomerUnitPrice({
      product: box12,
      units: [],
      customer: { tier: 2 },
      unit: "Box",
      rules: { 2: 8 },
    });
    expect(r.price).toBe(11.04);
  });

  it("PF-7: the source label follows the price: a typed value the price ignores is not 'customer'", () => {
    const r = resolveCustomerUnitPrice({
      product: box12,
      units: [],
      customer: { tier: 1, unitPrices: { pack: Infinity } },
      unit: "pack",
    });
    expect(r).toMatchObject({ price: 12, source: "list" });
  });

  it("an unknown unit is refused like the rest of the ladder", () => {
    expect(() =>
      resolveCustomerUnitPrice({
        product: box12,
        units: [],
        customer: { tier: 1 },
        unit: "Pallet",
      }),
    ).toThrow(/Unknown unit/);
  });

  it("T24b through the view options: a tier anchored on the Piece prices the Box off it", () => {
    const units = [lvl("Case", 72), lvl("Piece", 1, null, { priceTier3: "0.80" })];
    const piece = refForLabel(box12, units, "Piece");
    const r = resolveCustomerUnitPrice({
      product: box12,
      units,
      viewOptions: { tierOrderUnits: { 3: piece } },
      customer: { tier: 3 },
      unit: "pack",
    });
    expect(r.price).toBe(9.6);
    expect(buildLadderView(box12, units).rows.length).toBe(3);
  });
});

describe("S19 customerLayerPrice (SA-811a R1/R2): the customer layer, or null", () => {
  // pack list $42 (24 pieces), a Case of 288 at $480, a Can (1 piece) priced by the ladder
  const pack42: LadderProduct = { unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" };
  const caseUnit: LadderViewUnit = lvl("Case", 288, "480.00", { id: "u-case" });
  const input = (unitPrices: Record<string, number>, unit: string, extra = {}) => ({
    product: pack42,
    units: [caseUnit],
    customer: { tier: 1 as const, unitPrices, ...extra },
    unit,
  });

  it("R1a: typed pack $33 puts the Case in the customer layer in the customer's shape: 480 x 33/42 = $377.14", () => {
    const r = customerLayerPrice(input({ pack: 33 }, "Case"));
    expect(r).toMatchObject({
      price: 377.14,
      listPrice: 480,
      source: "customer-shape",
      aboveList: false,
    });
  });
  it("R1b: typed Case $450 on the customer's order unit puts the pack at 42 x 450/480 = $39.38", () => {
    const r = customerLayerPrice(input({ "u-case": 450 }, "pack", { orderUnit: "u-case" }));
    expect(r).toMatchObject({
      price: 39.38,
      listPrice: 42,
      source: "customer-shape",
      aboveList: false,
    });
  });
  it("a typed price on a non-anchor unit only leaves the anchor out of the layer (sticky still runs on the pack)", () => {
    expect(customerLayerPrice(input({ "u-case": 450 }, "pack"))).toBeNull();
    expect(customerLayerPrice(input({ "u-case": 450 }, "Case"))).toMatchObject({
      price: 450,
      source: "customer",
    });
  });
  it("no typed price at all: null for every unit (tier / list is the caller's own chain)", () => {
    expect(customerLayerPrice(input({}, "pack"))).toBeNull();
    expect(customerLayerPrice(input({}, "Case"))).toBeNull();
  });
  it("R2: above the unit's Retail ladder price is aboveList; at or below is not", () => {
    expect(customerLayerPrice(input({ pack: 45 }, "pack"))).toMatchObject({
      price: 45,
      listPrice: 42,
      aboveList: true,
    });
    expect(customerLayerPrice(input({ pack: 42 }, "pack"))?.aboveList).toBe(false);
    expect(customerLayerPrice(input({ pack: 33 }, "pack"))?.aboveList).toBe(false);
  });
});

describe("isSpecialPrice (moved from the api)", () => {
  it("a tier that is not Retail, or a customer-layer price off list by a cent, is special", () => {
    expect(isSpecialPrice(2, 42, null)).toBe(true);
    expect(isSpecialPrice(1, 42, null)).toBe(false);
    expect(isSpecialPrice(1, 42, 42)).toBe(false);
    expect(isSpecialPrice(1, 42, 42.004)).toBe(false);
    expect(isSpecialPrice(1, 42, 33)).toBe(true);
    expect(isSpecialPrice(1, 42, 45)).toBe(true);
  });
});
