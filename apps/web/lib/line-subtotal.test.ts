import { storedOrComputedLineSubtotal } from "./line-subtotal";

describe("storedOrComputedLineSubtotal", () => {
  it("a stored subtotal always wins (Decimal strings coerced)", () => {
    expect(
      storedOrComputedLineSubtotal({ subtotal: "11.50", qty: 24, unitPrice: 12.9, boxes: 1 }),
    ).toBe(11.5);
    expect(storedOrComputedLineSubtotal({ subtotal: 0, qty: 3, unitPrice: 2 })).toBe(0);
  });

  it("boxed: 1 box of 24 @ $12.90 is $12.90, never $309.60", () => {
    expect(
      storedOrComputedLineSubtotal({
        qty: 24,
        unitPrice: 12.9,
        boxes: 1,
        pieces: 0,
        unitsPerBox: 24,
      }),
    ).toBe(12.9);
  });

  it("mixed boxes + pieces prorate the loose pieces and round once (half away from zero)", () => {
    expect(
      storedOrComputedLineSubtotal({
        qty: 54,
        unitPrice: 12.9,
        boxes: 2,
        pieces: 6,
        unitsPerBox: 24,
      }),
    ).toBe(29.03);
  });

  it("non-boxed: qty x unitPrice, rounded to cents", () => {
    expect(storedOrComputedLineSubtotal({ qty: "3", unitPrice: "2.505" })).toBe(7.52);
  });

  it("subtracts the line discount and the BUY_N_GET_M free units", () => {
    expect(
      storedOrComputedLineSubtotal({
        qty: 120,
        unitPrice: 10,
        boxes: 12,
        pieces: 0,
        unitsPerBox: 10,
        promoFreeUnits: 2,
        discount: 5,
      }),
    ).toBe(95);
  });

  it("falls back to the product box size when the line carries no snapshot", () => {
    expect(
      storedOrComputedLineSubtotal({
        qty: 24,
        unitPrice: 12.9,
        boxes: 1,
        pieces: 0,
        product: { unitsPerBox: 24 },
      }),
    ).toBe(12.9);
  });

  it("never returns a negative or non-finite total", () => {
    expect(storedOrComputedLineSubtotal({ qty: 1, unitPrice: 5, discount: 50 })).toBe(0);
    expect(storedOrComputedLineSubtotal({ qty: "x", unitPrice: "y" })).toBe(0);
  });
});
