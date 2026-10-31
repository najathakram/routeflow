import { priceEditLineOf } from "./counter-sale-price-edit";
import type { SaleLine } from "./counter-sale-scan";

/**
 * SA-1069 U-2: the till's price editor takes a REQUIRED `unitWord` and labels its field from it. The till has no unit
 * line yet (U-1), so it passes the pack word for a boxed line and the line's own selling word for a plain one. Before,
 * the dialog hard-coded "box" and a plain line with no unit passed nothing.
 */
const base: SaleLine = {
  tempId: "a",
  productId: "p-a",
  name: "Water",
  unitPrice: 24,
  listPrice: 24,
  qty: 2,
  priceType: "STANDARD",
};

describe("priceEditLineOf unitWord (SA-1069 U-2)", () => {
  it("a boxed line carries the pack word", () => {
    const l = priceEditLineOf({ ...base, unitsPerBox: 12, boxes: 2, pieces: 0, qty: 24 }, 1);
    expect(l.unitWord).toBe("box");
  });

  it("a plain line carries its own selling word", () => {
    expect(priceEditLineOf({ ...base, unit: "lb" }, 1).unitWord).toBe("lb");
    expect(priceEditLineOf({ ...base, unit: "each" }, 1).unitWord).toBe("each");
  });

  it("a plain line with no unit still carries a word (never undefined)", () => {
    expect(typeof priceEditLineOf(base, 1).unitWord).toBe("string");
    expect(priceEditLineOf(base, 1).unitWord).not.toBe("");
  });
});
