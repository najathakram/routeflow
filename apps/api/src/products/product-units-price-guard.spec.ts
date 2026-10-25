import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertUnitPriceWritable } from "./product-units-price-guard";

const plain = { id: "p1", parentProductId: null, kind: "STANDARD" };
const variant = { id: "v1", parentProductId: "f1", kind: "VARIANT" };
const family = { id: "f1", parentProductId: null, kind: "FAMILY" };
const recipe = { id: "r1", parentProductId: null, kind: "RECIPE" };

describe("assertUnitPriceWritable (row 749, keep structure / drop prices)", () => {
  it("lets a plain product write prices", () => {
    expect(() => assertUnitPriceWritable(plain, { price: 5 })).not.toThrow();
  });

  it.each([
    ["variant", variant],
    ["family", family],
    ["recipe", recipe],
  ])("refuses a %s price write with the coded 409", (_n, p) => {
    for (const body of [{ price: 5 }, { priceTier3: 2 }, { price: null }]) {
      try {
        assertUnitPriceWritable(p, body);
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: API_ERROR_CODES.FAMILY_PRICE_AUTHORITY,
        });
      }
    }
  });

  it("names the family for a variant", () => {
    try {
      assertUnitPriceWritable(variant, { price: 1 });
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({ familyId: "f1" });
    }
  });

  it.each([variant, family, recipe])("still allows a structure-only write", (p) => {
    expect(() =>
      assertUnitPriceWritable(p, { label: "Case", factorToBase: 12, sortOrder: 1 }),
    ).not.toThrow();
  });
});
