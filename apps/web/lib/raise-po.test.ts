import { poIntentRefusal, raisePoBlocker } from "./raise-po";

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

describe("poIntentRefusal", () => {
  it("never refuses the bill flow (today's behaviour)", () => {
    expect(poIntentRefusal("bill", false, null)).toBeNull();
    expect(poIntentRefusal("bill", true, "Select a supplier first.")).toBeNull();
  });
  it("refuses a PO scan whose raise is switched off", () => {
    expect(poIntentRefusal("purchase-order", false, null)).toMatch(/Raise a purchase order/);
  });
  it("refuses a PO scan whose raise is blocked, naming the reason", () => {
    expect(poIntentRefusal("purchase-order", true, "Select a supplier first.")).toBe(
      "Can't draft the purchase order yet: Select a supplier first.",
    );
  });
  it("refuses an expense-only or both mode in PO intent (no PO would exist)", () => {
    expect(poIntentRefusal("purchase-order", true, null, "expense")).toMatch(
      /records only a bill and its PO/,
    );
    expect(poIntentRefusal("purchase-order", true, null, "both")).toMatch(
      /records only a bill and its PO/,
    );
    expect(poIntentRefusal("bill", false, null, "expense")).toBeNull();
  });
  it("lets a raisable PO scan through", () => {
    expect(poIntentRefusal("purchase-order", true, null)).toBeNull();
  });
});
