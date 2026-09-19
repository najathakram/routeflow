import { computeLineSubtotal } from "@routeflow/pricing";
import {
  MAX_ADD_QTY,
  mergeQtyIntoLine,
  mergedLineMessage,
  newLineQty,
  parseAddQty,
} from "./add-line-merge";

describe("parseAddQty", () => {
  it("parses a whole number", () => {
    expect(parseAddQty("12")).toBe(12);
    expect(parseAddQty(" 7 ")).toBe(7);
    expect(parseAddQty(3)).toBe(3);
  });

  it("blank, junk, zero and negatives fall back to 1 — a bad keystroke never adds nothing or subtracts", () => {
    for (const bad of ["", "abc", "0", "-4", null, undefined, Number.NaN]) {
      expect(parseAddQty(bad as never)).toBe(1);
    }
  });

  it("truncates a fraction and caps an absurd entry", () => {
    expect(parseAddQty("2.9")).toBe(2);
    expect(parseAddQty("1000000")).toBe(MAX_ADD_QTY);
  });
});

describe("newLineQty", () => {
  it("a plain product: qty is the count, no split", () => {
    expect(newLineQty(undefined, 5)).toEqual({ qty: 5, boxes: undefined, pieces: undefined });
  });

  it("a case-packed product: n cases, qty is total pieces", () => {
    expect(newLineQty(12, 1)).toEqual({ qty: 12, boxes: 1, pieces: 0 });
    expect(newLineQty(12, 3)).toEqual({ qty: 36, boxes: 3, pieces: 0 });
  });
});

describe("mergeQtyIntoLine", () => {
  it("a plain line: qty + n", () => {
    expect(mergeQtyIntoLine({ qty: 2 }, 1)).toEqual({ qty: 3 });
    expect(mergeQtyIntoLine({ qty: 2 }, 5)).toEqual({ qty: 7 });
  });

  it("REG: a repeat add of a boxed line adds a BOX and keeps qty consistent with boxes/pieces", () => {
    // Old behaviour: { ...li, qty: li.qty + 1 } -> qty 13 while boxes stayed 1 / pieces 0, so the
    // split (which pricing reads) and qty disagreed.
    const first = { qty: 12, unitsPerBox: 12, boxes: 1, pieces: 0 };
    const merged = mergeQtyIntoLine(first, 1);
    expect(merged).toMatchObject({ boxes: 2, pieces: 0, qty: 24 });
  });

  it("keeps loose pieces the operator already entered", () => {
    const line = { qty: 15, unitsPerBox: 12, boxes: 1, pieces: 3 };
    expect(mergeQtyIntoLine(line, 2)).toMatchObject({ boxes: 3, pieces: 3, qty: 39 });
  });

  it("the merged boxed line prices as boxes + pieces/upb (money math, not qty x price)", () => {
    const merged = mergeQtyIntoLine({ qty: 12, unitsPerBox: 12, boxes: 1, pieces: 0 }, 2);
    const total = computeLineSubtotal({
      unitPrice: 30,
      qty: merged.qty,
      boxes: merged.boxes,
      pieces: merged.pieces,
      unitsPerBox: merged.unitsPerBox,
    });
    expect(total).toBe(90); // 3 boxes x $30 — qty x price would say $1,080
  });

  it("does not mutate its input and preserves every other field (price, note, ...)", () => {
    const line = { qty: 1, unitPrice: 9.5, note: "keep", tempId: "t" };
    const out = mergeQtyIntoLine(line, 1);
    expect(line.qty).toBe(1);
    expect(out).toEqual({ qty: 2, unitPrice: 9.5, note: "keep", tempId: "t" });
  });
});

describe("mergedLineMessage", () => {
  it("names the line and its new quantity", () => {
    expect(mergedLineMessage("Sample Cola", { qty: 3 })).toBe("Sample Cola — now 3");
  });

  it("a boxed line reads in cases, and cases + loose pieces when there are any", () => {
    expect(
      mergedLineMessage("Sample Cola", { qty: 24, unitsPerBox: 12, boxes: 2, pieces: 0 }),
    ).toBe("Sample Cola — now 2 boxes");
    expect(
      mergedLineMessage("Sample Cola", { qty: 15, unitsPerBox: 12, boxes: 1, pieces: 3 }),
    ).toBe("Sample Cola — now 1 box + 3 pcs");
  });
});
