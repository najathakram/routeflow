import { returnTrayRows, setReturnLineQty, stepReturnLine } from "../lib/return-scan-tray";
import type { PrefilledReturnLine } from "../lib/inline-return-screen";

/**
 * #2694 — mobile returns scan into "What came back" through the SAME ScanOrderSheet as order
 * items. These pure helpers turn the return lines into the sheet's tray rows (no money: a return
 * line has no price until the quote) and apply the tray's stepper / qty edits back onto the lines.
 */
const line = (over: Partial<PrefilledReturnLine>): PrefilledReturnLine => ({
  productId: "p1",
  productName: "Widget",
  unit: "ea",
  unitsPerBox: null,
  boxes: "",
  pieces: "1",
  reason: "",
  note: "",
  soldLabel: "",
  ...over,
});

describe("#2694 returnTrayRows", () => {
  it("rows follow the scan order (newest first), then the rest; no money", () => {
    const lines = [
      line({ productId: "a", productName: "A", pieces: "2" }),
      line({ productId: "b", productName: "B", pieces: "1" }),
      line({ productId: "c", productName: "C", pieces: "" }),
    ];
    const rows = returnTrayRows(lines, ["b"]);
    expect(rows.map((r) => [r.id, r.qty, r.qtySummary, r.subtotal])).toEqual([
      ["b", 1, "1", 0],
      ["a", 2, "2", 0],
      ["c", 0, "0", 0],
    ]);
    expect(rows.every((r) => r.unlisted === false)).toBe(true);
  });

  it("a boxed line counts boxes × pack + pieces, summarised as cases", () => {
    const rows = returnTrayRows(
      [line({ productId: "cs", unitsPerBox: 24, boxes: "2", pieces: "3" })],
      [],
    );
    expect(rows[0]).toMatchObject({ qty: 51, qtySummary: "2 bx + 3", unitsPerBox: 24 });
  });
});

// SA-561 (#2704): a tray edit on a BOXED line goes back through the pack split
// (normalizeBoxesPieces), never "boxes '' + N pieces" — the case semantics survive the edit.
describe("#2694 SA-561 tray edits keep the pack split", () => {
  const cased = line({ productId: "cs", unitsPerBox: 24, boxes: "2", pieces: "3" });

  it("'2 bx + 3' stepped +1 ⇒ '2 bx + 4'", () => {
    const next = stepReturnLine([cased], "cs", +1);
    expect(next[0]).toMatchObject({ boxes: "2", pieces: "4" });
    expect(returnTrayRows(next, [])[0].qtySummary).toBe("2 bx + 4");
  });

  it("a typed 48 ⇒ '2 bx'", () => {
    const next = setReturnLineQty([cased], "cs", 48);
    expect(next[0]).toMatchObject({ boxes: "2", pieces: "" });
    expect(returnTrayRows(next, [])[0].qtySummary).toBe("2 bx");
  });

  it("stepping down across a case boundary ('2 bx' − 1 ⇒ '1 bx + 23')", () => {
    const two = line({ productId: "cs", unitsPerBox: 24, boxes: "2", pieces: "" });
    expect(stepReturnLine([two], "cs", -1)[0]).toMatchObject({ boxes: "1", pieces: "23" });
  });

  it("a non-boxed line is unchanged: plain pieces", () => {
    const plain = line({ productId: "p1", pieces: "4" });
    expect(setReturnLineQty([plain], "p1", 7)[0]).toMatchObject({ boxes: "", pieces: "7" });
  });
});

describe("#2694 tray edits", () => {
  it("setReturnLineQty sets the total in pieces; 0 or less removes the line", () => {
    const lines = [line({ productId: "cs", unitsPerBox: 24, boxes: "2", pieces: "3" })];
    expect(setReturnLineQty(lines, "cs", 5)[0]).toMatchObject({ boxes: "", pieces: "5" });
    expect(setReturnLineQty(lines, "cs", 0)).toEqual([]);
  });

  it("stepReturnLine adds or takes one piece; the last piece removes the line", () => {
    const lines = [line({ productId: "p1", pieces: "2" })];
    expect(stepReturnLine(lines, "p1", +1)[0].pieces).toBe("3");
    expect(stepReturnLine(lines, "p1", -1)[0].pieces).toBe("1");
    expect(stepReturnLine(stepReturnLine(lines, "p1", -1), "p1", -1)).toEqual([]);
  });
});
