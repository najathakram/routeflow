import {
  refusesLineEdit,
  setBoxesOnLines,
  setPiecesOnLines,
  setQtyOnLines,
  setSellByOnLines,
  setUnitQtyOnLines,
  stepQtyOnLines,
  type QtyEditLine,
} from "./line-qty-edit";
import { isUnitPending } from "@routeflow/pricing";

const isPendingDefaultUnit = (l: QtyEditLine) =>
  isUnitPending({ startOnDefaultUnit: l.startOnDefaultUnit, shaped: !!l.unitLabel });

/**
 * #2865 case c (SA-632): a line with no resolved unit is PENDING and its unit is decided ONCE. Any quantity
 * change on a pending line is REFUSED IN THE LOGIC (the line comes back unchanged), not only by a disabled
 * button; after the units resolve, "+" stays in the line's resolved unit.
 */
const base = (over: Partial<QtyEditLine> = {}): QtyEditLine => ({
  tempId: "a",
  productId: "p1",
  qty: 12,
  unitsPerBox: 12,
  boxes: 1,
  pieces: 0,
  startOnDefaultUnit: true,
  ...over,
});
const pending = () => base();
const settledPack = () => base({ startOnDefaultUnit: false });
const onBottles = () =>
  base({
    startOnDefaultUnit: false,
    unitLabel: "bottle",
    qty: 1,
    boxes: undefined,
    pieces: undefined,
  });

describe("a PENDING line refuses every quantity edit (case c)", () => {
  it("is pending by the shared predicate", () => {
    expect(isPendingDefaultUnit(pending())).toBe(true);
  });

  it.each([
    ["stepQty +1", (l: QtyEditLine[]) => stepQtyOnLines(l, "a", 1)],
    ["stepQty -1", (l: QtyEditLine[]) => stepQtyOnLines(l, "a", -1)],
    ["typed qty", (l: QtyEditLine[]) => setQtyOnLines(l, "a", 5)],
    ["typed boxes", (l: QtyEditLine[]) => setBoxesOnLines(l, "a", 3)],
    ["typed pieces", (l: QtyEditLine[]) => setPiecesOnLines(l, "a", 3)],
    ["typed unit qty", (l: QtyEditLine[]) => setUnitQtyOnLines(l, "a", 7)],
    [
      "sell-by toggle (it also consumes the flag)",
      (l: QtyEditLine[]) => setSellByOnLines(l, "a", "unit"),
    ],
  ])("%s returns the SAME lines array and leaves the line pending", (_n, run) => {
    const lines = [pending()];
    const out = run(lines);
    expect(out).toBe(lines);
    expect(out[0]).toEqual(pending());
    expect(isPendingDefaultUnit(out[0])).toBe(true);
  });

  it("case c: '+' before the ladder loads leaves exactly the ONE pending line, never 2 cases (qty 24)", () => {
    const out = stepQtyOnLines([pending()], "a", 1);
    expect(out[0].qty).toBe(12);
    expect(out[0].boxes).toBe(1);
    expect(out[0].startOnDefaultUnit).toBe(true);
  });

  it("other lines are still editable while one is pending", () => {
    const other = {
      ...settledPack(),
      tempId: "b",
      qty: 1,
      unitsPerBox: undefined,
      boxes: undefined,
      pieces: undefined,
    };
    const out = stepQtyOnLines([pending(), other], "b", 1);
    expect(out[1].qty).toBe(2);
    expect(out[0]).toEqual(pending());
  });
});

describe("after the units resolve", () => {
  it("'+' stays in the line's resolved UNIT (a plain +1 count), never a box step", () => {
    const out = stepQtyOnLines([onBottles()], "a", 1);
    expect(out[0].qty).toBe(2);
    expect(out[0].unitLabel).toBe("bottle");
    expect(out[0].boxes).toBeUndefined();
  });

  it("a settled non-boxed line steps by 1 exactly as before", () => {
    const plain = {
      ...settledPack(),
      unitsPerBox: undefined,
      boxes: undefined,
      pieces: undefined,
      qty: 3,
    };
    expect(stepQtyOnLines([plain], "a", 1)[0].qty).toBe(4);
    expect(stepQtyOnLines([plain], "a", -1)[0].qty).toBe(2);
  });

  it("typed boxes / pieces / unit qty on a settled boxed line behave as before and consume nothing new", () => {
    const l = [settledPack()];
    expect(setBoxesOnLines(l, "a", 3)[0]).toMatchObject({ boxes: 3, qty: 36 });
    expect(setPiecesOnLines(l, "a", 5)[0]).toMatchObject({ pieces: 5, qty: 17 });
    expect(setUnitQtyOnLines(l, "a", 25)[0]).toMatchObject({ boxes: 2, pieces: 1, qty: 25 });
  });

  it("typed qty on a settled line works as before (whole number, at least 1)", () => {
    const out = setQtyOnLines([onBottles()], "a", 0);
    expect(out[0].qty).toBe(1);
  });
});

describe("refusesLineEdit (SA-632 H1: a typed price is refused on a pending line exactly like a quantity)", () => {
  it("refuses qty, price, unit and increment on a PENDING line; never a settled one; a tap is allowed", () => {
    for (const intent of ["qty", "price", "unit", "increment"] as const) {
      expect(refusesLineEdit(pending(), intent)).toBe(true);
      expect(refusesLineEdit(base({ startOnDefaultUnit: false }), intent)).toBe(false);
    }
    expect(refusesLineEdit(pending(), "tap")).toBe(false);
  });
});
