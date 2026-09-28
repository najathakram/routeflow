import {
  caseSizeOf,
  defaultBillQty,
  halfBillQty,
  remainderPieces,
  stepBillQty,
  formatSplitQty,
} from "../lib/split-invoice-cases";

// SA-178 item 5 / #2074: guidance only. A partial Case is legitimate, so nothing here refuses.
const caseLine = { unitLabel: "Case", unitsPerBox: 12 };
const packLine = { unitLabel: null, unitsPerBox: 12, unit: "box" };

describe("caseSizeOf", () => {
  it("is the line's own unitsPerBox for a unit line, null otherwise", () => {
    expect(caseSizeOf(caseLine)).toBe(12);
    expect(caseSizeOf(packLine)).toBeNull();
    expect(caseSizeOf({ unitLabel: "Case", unitsPerBox: null })).toBeNull();
    expect(caseSizeOf({ unitLabel: "Piece", unitsPerBox: 1 })).toBeNull();
  });
});

describe("defaultBillQty", () => {
  it("defaults a unit line to whole Cases", () => {
    expect(defaultBillQty(52, 12)).toBe(48);
    expect(defaultBillQty(48, 12)).toBe(48);
  });
  it("is 0 when less than a Case remains (offer the remainder instead)", () => {
    expect(defaultBillQty(5, 12)).toBe(0);
  });
  it("bills everything for a non-unit line", () => {
    expect(defaultBillQty(52, null)).toBe(52);
  });
});

describe("halfBillQty", () => {
  it("rounds to WHOLE Cases, never a partial Case", () => {
    expect(halfBillQty(120, 12)).toBe(60); // 10 Cases -> 5
    expect(halfBillQty(132, 12)).toBe(72); // 11 Cases -> ceil(5.5)=6
    expect(halfBillQty(52, 12)).toBe(24); // 4 whole Cases -> 2 (the 4 loose pcs are not halved)
    expect(halfBillQty(5, 12)).toBe(0);
  });
  it("keeps the old ceil(cap/2) for a non-unit line", () => {
    expect(halfBillQty(7, null)).toBe(4);
  });
});

describe("remainderPieces", () => {
  it("is the loose pieces beyond whole Cases, 0 for non-unit lines", () => {
    expect(remainderPieces(52, 12)).toBe(4);
    expect(remainderPieces(48, 12)).toBe(0);
    expect(remainderPieces(52, null)).toBe(0);
  });
});

describe("stepBillQty", () => {
  it("steps by the Case size and clamps to the remaining quantity", () => {
    expect(stepBillQty(0, 1, 52, 12)).toBe(12);
    expect(stepBillQty(48, 1, 52, 12)).toBe(52);
    expect(stepBillQty(24, -1, 52, 12)).toBe(12);
    expect(stepBillQty(0, -1, 52, 12)).toBe(0);
  });
  it("steps by 1 for a non-unit line", () => {
    expect(stepBillQty(3, 1, 10, null)).toBe(4);
  });
});

describe("formatSplitQty", () => {
  it("reads through the label-aware formatter", () => {
    expect(formatSplitQty(52, { ...caseLine, unit: "box" })).toBe("4 Cases + 4 pcs");
    expect(formatSplitQty(48, caseLine)).toBe("4 Cases");
    expect(formatSplitQty(12, caseLine)).toBe("1 Case");
    expect(formatSplitQty(5, caseLine)).toBe("5 pcs");
    expect(formatSplitQty(0, caseLine)).toBe("0");
  });
  it("keeps the plain '<qty> <unit>' for a non-unit line", () => {
    expect(formatSplitQty(7, { unit: "box" })).toBe("7 box");
    expect(formatSplitQty(7, {})).toBe("7 ea");
  });
});
