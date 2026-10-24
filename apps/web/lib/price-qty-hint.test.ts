import { priceQtyHint } from "./price-qty-hint";

describe("priceQtyHint (V09)", () => {
  it("asks when a whole-number price equals the units per box", () => {
    expect(priceQtyHint({ price: "12", unitsPerBox: "12", packWord: "box" })).toBe(
      "A box holds 12. Is $12.00 the price for the whole box?",
    );
  });

  it("treats 12.00 as whole, and uses the form's pack word", () => {
    expect(priceQtyHint({ price: "12.00", unitsPerBox: "12", packWord: "case" })).toBe(
      "A case holds 12. Is $12.00 the price for the whole case?",
    );
  });

  it("stays quiet for a price with cents", () => {
    expect(priceQtyHint({ price: "12.50", unitsPerBox: "12", packWord: "box" })).toBeNull();
  });

  it("stays quiet when the price differs from the count", () => {
    expect(priceQtyHint({ price: "24", unitsPerBox: "12", packWord: "box" })).toBeNull();
  });

  it("stays quiet when the product is not boxed", () => {
    expect(priceQtyHint({ price: "1", unitsPerBox: "1", packWord: "box" })).toBeNull();
    expect(priceQtyHint({ price: "12", unitsPerBox: "", packWord: "box" })).toBeNull();
    expect(priceQtyHint({ price: "", unitsPerBox: "12", packWord: "box" })).toBeNull();
    expect(priceQtyHint({ price: "0", unitsPerBox: "0", packWord: "box" })).toBeNull();
  });

  it("ignores values that are not plain numbers", () => {
    expect(priceQtyHint({ price: "abc", unitsPerBox: "12", packWord: "box" })).toBeNull();
    expect(priceQtyHint({ price: "12", unitsPerBox: "12.5", packWord: "box" })).toBeNull();
  });
});
