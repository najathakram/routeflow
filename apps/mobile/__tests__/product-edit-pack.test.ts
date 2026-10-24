import { expectedPackFor } from "../lib/product-edit-pack";

describe("expectedPackFor (mobile): SA-797, the pack the edit form opened with rides with its save", () => {
  const opened = { unit: "Case", unitsPerBox: 24, packTenantUnitId: "tu-case" };
  it("sends the word, size and tenant unit the form OPENED with", () => {
    expect(expectedPackFor("Case", opened)).toEqual({
      expectedUnit: "Case",
      expectedUnitsPerBox: 24,
      expectedTenantUnitId: "tu-case",
    });
  });
  it("sends nothing without unit, or before the product loaded", () => {
    expect(expectedPackFor(undefined, opened)).toEqual({});
    expect(expectedPackFor("Case", null)).toEqual({});
  });
  it("an unlinked word sends no tenant unit; an unset size is null", () => {
    expect(expectedPackFor("Case", { unit: "Case", packTenantUnitId: null })).toEqual({
      expectedUnit: "Case",
      expectedUnitsPerBox: null,
    });
  });
});
