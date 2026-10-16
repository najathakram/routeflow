import { buildLadderView, refForLabel, type LadderViewUnit } from "./price-ladder";
import { customerTierFor, resolveCustomerUnitPrice } from "./customer-unit-price";
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
