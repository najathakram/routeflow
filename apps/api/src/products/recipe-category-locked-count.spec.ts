import { countLockedProducts, recipeCategoryLocked } from "./recipe-rules";

/** SA-587a (iii): the RECIPE_CATEGORY_LOCKED 409 carries the COUNT of locked products, never ids/names. */
describe("recipeCategoryLocked count (SA-587a)", () => {
  it("the body carries lockedCount and nothing that names a product", () => {
    const body = recipeCategoryLocked(3).getResponse() as Record<string, unknown>;
    expect(body).toMatchObject({ code: "RECIPE_CATEGORY_LOCKED", lockedCount: 3 });
    expect(Object.keys(body).sort()).toEqual(["code", "lockedCount", "message"]);
  });

  it("countLockedProducts counts DISTINCT moving ids held in any role by the open recipes", () => {
    const recipes = [
      { productId: "rp", familyProductId: "fam", components: [{ componentProductId: "v1" }] },
      { productId: "rp2", familyProductId: "fam", components: [{ componentProductId: "v1" }] },
    ];
    expect(countLockedProducts(["v1", "fam", "free"], recipes)).toBe(2);
    expect(countLockedProducts(["free"], recipes)).toBe(0);
    expect(countLockedProducts(["rp", "rp2", "v1"], recipes)).toBe(3);
  });
});
