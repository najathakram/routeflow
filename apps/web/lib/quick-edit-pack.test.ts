import { quickPackEdit } from "./quick-edit-pack";

describe("Quick Edit pieces-per-box (SA-797a MUST-1): the pack the cell read rides on save, undo and redo", () => {
  const row = { unit: "Box", unitsPerBox: 12, packTenantUnitId: "tu-box" };

  it("save sends the size as a NUMBER with the expected pack the cell read", () => {
    const { save } = quickPackEdit(row, "6");
    expect(save).toEqual({
      unitsPerBox: 6,
      expectedUnit: "Box",
      expectedUnitsPerBox: 12,
      expectedTenantUnitId: "tu-box",
    });
    expect(typeof save.unitsPerBox).toBe("number");
  });

  it("clearing the cell sends null (not '') with the expected pack: no PRECONDITION_REQUIRED dead end", () => {
    expect(quickPackEdit(row, "  ").save).toMatchObject({
      unitsPerBox: null,
      expectedUnit: "Box",
      expectedUnitsPerBox: 12,
    });
  });

  it("undo restores the old size; its expected pack is the POST-save values", () => {
    const { undo } = quickPackEdit(row, "6");
    expect(undo).toEqual({
      unitsPerBox: 12,
      expectedUnit: "Box",
      expectedUnitsPerBox: 6,
      expectedTenantUnitId: "tu-box",
    });
  });

  it("redo re-applies the new size against the pre-save values", () => {
    expect(quickPackEdit(row, "6").redo).toEqual(quickPackEdit(row, "6").save);
  });

  it("a row with no size and no linked unit reads as null / no tenant unit", () => {
    expect(quickPackEdit({ unit: "Each", unitsPerBox: null }, "24").save).toEqual({
      unitsPerBox: 24,
      expectedUnit: "Each",
      expectedUnitsPerBox: null,
    });
  });
});
