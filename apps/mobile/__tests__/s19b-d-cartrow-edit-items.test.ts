import { readFileSync } from "fs";
import { join } from "path";
import { isSpecialTier, type CustomerLayerUnit } from "@routeflow/pricing";
import { layerUnitBaseFor, packIsSpecial } from "../lib/cart-order-total";
import type { Product } from "../lib/cart-line-state";

// S19b slice D, follow-up (lead decision): edit-items' isSpecialFor reads the customer layer, and the cart's CartRow prices a
// unit line with a layer row at the LAYER price, not the pack-level catalogPrice. Flag-on layered cases ONLY; the flag-off
// assertions live, unchanged, in edit-items-drawer / edit-items-special-tier-reason / cart-order-total.

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const editItems = read("app/(operator)/(tabs)/orders/[id]/edit-items.tsx");
const cartModal = read("components/new-order/CartModal.tsx");
const cartRow = read("components/CartRow.tsx");
const newOrder = read("components/NewOrderScreen.tsx");
const invoiceNew = read("app/(operator)/(tabs)/invoices/new.tsx");

const product: Product = {
  id: "p1",
  name: "Soda 24pk",
  pricePerUnit: "42.00",
  priceTier3: "39.00",
  unitsPerBox: 24,
};
const row = (over: Partial<CustomerLayerUnit>): CustomerLayerUnit => ({
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
  ...over,
});
const packA = row({});
const caseA = row({
  ref: "u-case",
  label: "Case",
  price: 377.14,
  listPrice: 480,
  source: "customer-shape",
});

describe("edit-items isSpecialFor is layer-aware (flag on, layered)", () => {
  it("a layered SPECIAL at tier 1 is SPECIAL (gated like a tier SPECIAL); no layer is isSpecialTier exactly", () => {
    expect(packIsSpecial(1, [packA])).toBe(true);
    for (const t of [1, 2, 3, 4, 5]) expect(packIsSpecial(t, undefined)).toBe(isSpecialTier(t));
  });
  it("isSpecialFor reads the layer through packIsSpecial, and every pinned use site still calls isSpecialFor", () => {
    expect(editItems).toMatch(
      /const isSpecialFor = \(productId: string\) =>\s*packIsSpecial\(effectiveTierFor\(productId\), layerOf\(productId\)\)/,
    );
    expect(editItems).toMatch(/isSpecial=\{isSpecialFor\(priceEditItem\.item\.productId\)\}/);
    expect(editItems).toMatch(/isSpecialTierFor=\{isSpecialFor\}/);
  });
});

describe("CartRow prices a unit line with a layer row at the layer price", () => {
  it("layerUnitBaseFor: the Case row price for a Case line, even a case-different label; undefined otherwise", () => {
    expect(layerUnitBaseFor({ unitLabel: "Case" }, product, 3, [packA, caseA])).toBe(377.14);
    expect(layerUnitBaseFor({ unitLabel: "case" }, product, 3, [packA, caseA])).toBe(377.14);
    expect(layerUnitBaseFor({ unitLabel: "Case" }, product, 3, [packA])).toBeUndefined(); // no Case row
    expect(layerUnitBaseFor({}, product, 3, [packA, caseA])).toBeUndefined(); // pack lines use catalogPrice
    expect(layerUnitBaseFor({ unitLabel: "Case" }, product, 3, undefined)).toBeUndefined(); // flag off
  });
  it("CartModal threads the layer base into CartRow, and CartRow prefers it over unitPriceBase", () => {
    expect(cartModal).toMatch(/layerUnitBase=\{layerUnitBaseFor\(/);
    expect(cartRow).toMatch(/layerUnitBase \?\? unitPriceBase\(line, catalogPrice\)/);
  });
  it("NewOrderScreen hands the layer to CartModal", () => {
    expect(newOrder).toMatch(/layerOf=\{layerOf\}/);
  });
  it("invoices/new's review row reads a unit line's layer price too", () => {
    expect(invoiceNew).toMatch(
      /line=\{withLayerBase\(line, product, tierFor\(id\), layerOf\?\.\(id\)\)\}/,
    );
    expect(invoiceNew).toMatch(/layerOf=\{layerOf\}/);
  });
});
