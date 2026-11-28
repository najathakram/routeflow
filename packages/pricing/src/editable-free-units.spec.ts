import { editableFreeUnits } from "./editable-free-units";

/** SA-1508 A3-H2 / A4-L4. Red on master: the helper does not exist (web and mobile each carried a copy). */
describe("editableFreeUnits", () => {
  it("a line with no free units reads 0", () => {
    expect(editableFreeUnits({ qty: 5 })).toBe(0);
    expect(editableFreeUnits({ promoFreeUnits: 0, qty: 5 })).toBe(0);
    expect(editableFreeUnits({ promoFreeUnits: null, boxes: 3, qty: 36 })).toBe(0);
  });

  it("keeps the stored free units while the line stays at its earned quantity (capped at units - 1)", () => {
    expect(editableFreeUnits({ promoFreeUnits: 2, boxes: 6, qty: 72 })).toBe(2);
    expect(editableFreeUnits({ promoFreeUnits: 1, qty: 4 })).toBe(1);
  });

  it("the over-cap row (1 free on a 1-box line, the partial-allocation shape) reads 0: the buyer pays the N", () => {
    expect(editableFreeUnits({ promoFreeUnits: 1, boxes: 1, qty: 12 })).toBe(0);
    expect(editableFreeUnits({ promoFreeUnits: 1, qty: 1 })).toBe(0);
  });

  it("a shrunk line earns proportionally fewer; a grown one never earns more than was agreed", () => {
    expect(editableFreeUnits({ promoFreeUnits: 4, promoBaseUnits: 8, boxes: 4, qty: 48 })).toBe(2);
    expect(editableFreeUnits({ promoFreeUnits: 4, promoBaseUnits: 8, boxes: 16, qty: 192 })).toBe(
      4,
    );
  });

  it("units are the boxes of a boxed line, else the qty; loose pieces never count", () => {
    expect(editableFreeUnits({ promoFreeUnits: 3, boxes: 2, qty: 100 })).toBe(1); // 2 boxes: cap 1, not 99
    expect(editableFreeUnits({ promoFreeUnits: 3, boxes: null, qty: 2 })).toBe(1);
  });

  it("a zero or negative quantity, or a zero base, never throws", () => {
    expect(editableFreeUnits({ promoFreeUnits: 2, boxes: 0, qty: 0 })).toBe(0);
    expect(editableFreeUnits({ promoFreeUnits: 2, boxes: -1, qty: -1 })).toBe(0);
    expect(editableFreeUnits({ promoFreeUnits: 2, promoBaseUnits: 0, boxes: 4, qty: 48 })).toBe(2);
    expect(editableFreeUnits({ promoFreeUnits: 2.9, boxes: 5, qty: 60 })).toBe(2);
  });
});
