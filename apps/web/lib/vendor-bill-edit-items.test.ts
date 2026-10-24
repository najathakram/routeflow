import { editItemsField } from "./vendor-bill-edit-items";

describe("editItemsField (B292)", () => {
  it("a header-only bill with no added line omits items (a header edit keeps its zero lines)", () => {
    expect(editItemsField([], 0)).toEqual({});
    expect("items" in editItemsField([], 0)).toBe(false);
  });

  it("a header-only bill where the user added a line sends it", () => {
    expect(editItemsField([{ description: "Freight" }], 0)).toEqual({
      items: [{ description: "Freight" }],
    });
  });

  it("a bill that had lines sends the edited list, including an emptied one (the server refuses it)", () => {
    expect(editItemsField([{ description: "Flour" }], 2)).toEqual({
      items: [{ description: "Flour" }],
    });
    expect(editItemsField([], 2)).toEqual({ items: [] });
  });
});
