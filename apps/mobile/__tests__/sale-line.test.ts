import { incrementLine } from "../lib/sale-line";

describe("incrementLine", () => {
  it("increments a plain line and PRESERVES unitPrice/note/noteOpen (repeat-scan field wipe fix)", () => {
    const prev = { qty: 2, unitPrice: 9.5, note: "chilled", noteOpen: true };
    const next = incrementLine(prev, false, 0);
    expect(next.qty).toBe(3);
    expect(next.unitPrice).toBe(9.5);
    expect(next.note).toBe("chilled");
    expect(next.noteOpen).toBe(true);
  });

  it("increments a boxed line by one BOX and preserves fields", () => {
    const prev = { qty: 12, boxes: 1, pieces: 0, unitPrice: 20, note: "n" };
    const next = incrementLine(prev, true, 12);
    expect(next.boxes).toBe(2);
    expect(next.pieces).toBe(0);
    expect(next.qty).toBe(24);
    expect(next.unitPrice).toBe(20);
    expect(next.note).toBe("n");
  });

  it("keeps loose pieces when adding a box", () => {
    const next = incrementLine({ qty: 15, boxes: 1, pieces: 3 }, true, 12);
    expect(next.boxes).toBe(2);
    expect(next.pieces).toBe(3);
    expect(next.qty).toBe(27); // 2*12 + 3
  });

  it("starts a new line from a zero default", () => {
    expect(incrementLine({ qty: 0 }, false, 0).qty).toBe(1);
    const boxed = incrementLine({ qty: 0 }, true, 6);
    expect(boxed.boxes).toBe(1);
    expect(boxed.qty).toBe(6);
  });

  it("a second increment compounds on the first (repeat scans stack)", () => {
    let line: { qty?: number; unitPrice?: number } = { qty: 0, unitPrice: 7 };
    line = incrementLine(line, false, 0);
    line = incrementLine(line, false, 0);
    line = incrementLine(line, false, 0);
    expect(line.qty).toBe(3);
    expect(line.unitPrice).toBe(7); // survived every increment
  });
});
