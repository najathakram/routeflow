import { familyOwnerIdOf } from "./family-price";

describe("familyOwnerIdOf (SA-1041 A-2)", () => {
  it("returns the parent for a variant", () => {
    expect(familyOwnerIdOf({ parentProductId: "f1", recipeFamilyId: null })).toBe("f1");
  });
  it("returns the recipe's family for an unparented recipe", () => {
    expect(familyOwnerIdOf({ parentProductId: null, recipeFamilyId: "f2" })).toBe("f2");
  });
  it("prefers the parent over the recipe family", () => {
    expect(familyOwnerIdOf({ parentProductId: "f1", recipeFamilyId: "f2" })).toBe("f1");
  });
  it("throws when neither is set rather than naming the product itself", () => {
    expect(() => familyOwnerIdOf({})).toThrow(/no owning family/);
  });
});
