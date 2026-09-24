import { raisePoBlocker } from "./raise-po";

describe("raisePoBlocker", () => {
  it("needs a supplier and at least one line", () => {
    expect(raisePoBlocker("", [{ productId: "p1" }])).toBe("Select a supplier first.");
    expect(raisePoBlocker("s1", [])).toBe("Add at least one line first.");
  });

  it("names how many lines still need a product", () => {
    expect(raisePoBlocker("s1", [{ productId: "p1" }, { productId: "" }])).toBe(
      "Match the 1 unmatched line to a product first.",
    );
    expect(raisePoBlocker("s1", [{ productId: null }, {}, { productId: "p" }])).toBe(
      "Match the 2 unmatched lines to a product first.",
    );
  });

  it("is null when the PO can be raised", () => {
    expect(raisePoBlocker("s1", [{ productId: "p1" }, { productId: "p2" }])).toBeNull();
  });
});
