import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertUnitPriceWritable } from "./product-units-price-guard";

const plain = { id: "p1", parentProductId: null, kind: "STANDARD" };
const variant = { id: "v1", parentProductId: "f1", kind: "VARIANT" };
const family = { id: "f1", parentProductId: null, kind: "FAMILY" };
const recipeOwn = { id: "r1", parentProductId: null, kind: "RECIPE", recipeFamilyId: null };
const recipeLinked = { id: "r2", parentProductId: null, kind: "RECIPE", recipeFamilyId: "f1" };
const recipeOverride = {
  id: "r3",
  parentProductId: null,
  kind: "RECIPE",
  familyPriceOverride: true,
  recipeFamilyId: "f1",
};

const on = (level: "base" | "other", op: "create" | "update" = "update") =>
  ({ mode: "on", level, op }) as const;
const off = (level: "base" | "other", op: "create" | "update" = "update") =>
  ({ mode: "off", level, op }) as const;

function refusal(fn: () => void): ConflictException {
  try {
    fn();
  } catch (e) {
    return e as ConflictException;
  }
  throw new Error("did not throw");
}

describe("assertUnitPriceWritable (priceAuthority decides, SA-1041)", () => {
  it("lets a plain product write prices in both modes", () => {
    expect(() => assertUnitPriceWritable(plain, { price: 5 }, on("base"))).not.toThrow();
    expect(() => assertUnitPriceWritable(plain, { price: 5 }, off("base"))).not.toThrow();
  });

  it.each([
    ["variant", variant],
    ["recipe with a family link", recipeLinked],
  ])("mode on: refuses a %s base-level price with the coded 409", (_n, p) => {
    for (const body of [{ price: 5 }, { priceTier3: 2 }]) {
      const e = refusal(() => assertUnitPriceWritable(p, body, on("base")));
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse()).toMatchObject({ code: API_ERROR_CODES.FAMILY_PRICE_AUTHORITY });
    }
  });

  it.each([
    ["variant", variant],
    ["recipe with a family link", recipeLinked],
    ["recipe without a link", recipeOwn],
    ["recipe with the override", recipeOverride],
  ])("mode on: a %s non-base unit price is its own (owner Q1)", (_n, p) => {
    expect(() => assertUnitPriceWritable(p, { price: 480 }, on("other"))).not.toThrow();
  });

  it.each([
    ["variant", variant],
    ["recipe with a family link", recipeLinked],
    ["recipe without a link", recipeOwn],
  ])("mode off: a %s price is its own at every level", (_n, p) => {
    expect(() => assertUnitPriceWritable(p, { price: 5 }, off("base"))).not.toThrow();
    expect(() => assertUnitPriceWritable(p, { price: 5 }, off("other"))).not.toThrow();
  });

  it("a recipe without a link or with the override is its own at base, mode on", () => {
    expect(() => assertUnitPriceWritable(recipeOwn, { price: 5 }, on("base"))).not.toThrow();
    expect(() => assertUnitPriceWritable(recipeOverride, { price: 5 }, on("base"))).not.toThrow();
  });

  it("a FAMILY refuses a price at every level and mode", () => {
    for (const o of [on("base"), on("other"), off("base"), off("other")]) {
      const e = refusal(() => assertUnitPriceWritable(family, { price: 5 }, o));
      expect(e.getResponse()).toMatchObject({
        code: API_ERROR_CODES.FAMILY_PRICE_AUTHORITY,
        familyId: "f1",
      });
    }
  });

  it("create ignores a null price (legacy add form); update refuses clearing one", () => {
    expect(() =>
      assertUnitPriceWritable(variant, { label: "Case", price: null }, on("base", "create")),
    ).not.toThrow();
    expect(() => assertUnitPriceWritable(variant, { price: 5 }, on("base", "create"))).toThrow(
      ConflictException,
    );
    expect(() => assertUnitPriceWritable(variant, { price: null }, on("base"))).toThrow(
      ConflictException,
    );
  });

  it("names the family for a variant", () => {
    const e = refusal(() => assertUnitPriceWritable(variant, { price: 1 }, on("base")));
    expect(e.getResponse()).toMatchObject({ familyId: "f1" });
  });

  it.each([variant, family, recipeLinked])("still allows a structure-only write", (p) => {
    expect(() =>
      assertUnitPriceWritable(p, { label: "Case", factorToBase: 12, sortOrder: 1 }, on("base")),
    ).not.toThrow();
  });
});
