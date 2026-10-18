import { expectedPackFor, packWordToSend } from "./product-edit-unit";

describe("packWordToSend: a stale form must not overwrite a unit rename", () => {
  it("sends nothing when the pack word was not edited (the form opened with Case; a rename made it Carton meanwhile)", () => {
    expect(packWordToSend("Case", "Case")).toBeUndefined();
  });
  it("sends the new word when the operator changed it", () => {
    expect(packWordToSend("Crate", "Case")).toBe("Crate");
  });
  it("a blank edit is left unchanged, never sent", () => {
    expect(packWordToSend("", "Case")).toBeUndefined();
    expect(packWordToSend(undefined, "Case")).toBeUndefined();
  });
});

describe("expectedPackFor: SA-797, the pack the form read rides with a save that carries unit", () => {
  const opened = { unit: "Case", unitsPerBox: 24, packTenantUnitId: "tu-case" };
  it("sends the word, size and tenant unit the form OPENED with", () => {
    expect(expectedPackFor({ unit: "Crate" }, opened)).toEqual({
      expectedUnit: "Case",
      expectedUnitsPerBox: 24,
      expectedTenantUnitId: "tu-case",
    });
  });
  it("SA-797a: a save that carries only unitsPerBox sends the expected pack too", () => {
    expect(expectedPackFor({ unitsPerBox: 12 }, opened)).toEqual({
      expectedUnit: "Case",
      expectedUnitsPerBox: 24,
      expectedTenantUnitId: "tu-case",
    });
    expect(expectedPackFor({ unitsPerBox: null }, opened)).toMatchObject({ expectedUnit: "Case" });
  });
  it("sends nothing when the save carries neither unit nor unitsPerBox", () => {
    expect(expectedPackFor({}, opened)).toEqual({});
  });
  it("an unlinked word sends no tenant unit; an unset size is null", () => {
    expect(expectedPackFor({ unit: "Crate" }, { unit: "Case", packTenantUnitId: null })).toEqual({
      expectedUnit: "Case",
      expectedUnitsPerBox: null,
    });
  });
});
