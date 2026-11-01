import { addScannedProduct, stepLine, type SaleLine } from "./counter-sale-scan";
import { COUNTER_MAX_LINE_QTY } from "./counter-sale-line-edit";

/** W-833: the server refuses a line over 100,000 pieces, so the stepper and the scan-add stop at it too. */
const plain = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
const boxed = { id: "p-soda", name: "Soda", pricePerUnit: 24, unit: "box", unitsPerBox: 12 };
const lineOf = (over: Partial<SaleLine>): SaleLine => ({
  tempId: "t1",
  productId: "p-cola",
  name: "Cola",
  unitPrice: 2.5,
  qty: 1,
  ...over,
});
const add = (prev: SaleLine[], product: any, level: "UNIT" | "PACK", n: number) =>
  addScannedProduct(prev, product, level as any, n, 1);

describe("the per-line cap on the stepper and the scan-add (W-833)", () => {
  it("a plain line steps up to the cap and no further", () => {
    const atCap = lineOf({ qty: COUNTER_MAX_LINE_QTY });
    expect(stepLine(atCap, "piece", 1)).toBe(atCap);
    expect(stepLine(lineOf({ qty: COUNTER_MAX_LINE_QTY - 1 }), "piece", 1).qty).toBe(
      COUNTER_MAX_LINE_QTY,
    );
  });

  it("a boxed line's Box step refuses to pass the cap (9999 boxes x 12 is over it)", () => {
    const l = lineOf({ unitsPerBox: 12, boxes: 8333, pieces: 3, qty: 8333 * 12 + 3 });
    expect(stepLine(l, "box", 1)).toBe(l); // 8334 x 12 + 3 = 100,011
    expect(stepLine(l, "piece", 1).qty).toBe(l.qty + 1);
  });

  it("a repeat scan past the cap leaves the cart as it was", () => {
    const prev = [lineOf({ qty: COUNTER_MAX_LINE_QTY - 1 })];
    expect(add(prev, plain, "PACK", 2)).toBe(prev);
    expect(add(prev, plain, "PACK", 1)[0].qty).toBe(COUNTER_MAX_LINE_QTY);
  });

  it("a new boxed line of 9999 boxes (119,988 pieces) is not added", () => {
    const prev: SaleLine[] = [];
    expect(add(prev, boxed, "PACK", 9999)).toBe(prev);
    expect(add(prev, boxed, "PACK", 100)).toHaveLength(1);
  });
});
