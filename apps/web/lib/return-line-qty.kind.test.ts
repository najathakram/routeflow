import { returnedItemQtyText } from "./return-line-qty";

/**
 * SA-1231 H1 (VF-6): a returned item's quantity follows the writer that stored it. An INLINE item always stores pieces, so
 * a legacy line (or none) reads "N pcs", never a bare count; a split line reads its own boxes. A STANDARD item with no line
 * reads the bare number the invoice prints. Without `kind` the text is exactly what it was (every existing caller).
 */
const SPLIT_CASE = { unitLabel: null, unitsPerBox: 24, boxes: 1, pieces: 0, qty: 1 };
const LEGACY = { unitLabel: null, unitsPerBox: null, boxes: null, pieces: null, qty: 1 };
const UNIT_CASE = { unitLabel: "Case", unitsPerBox: 1, boxes: null, pieces: null, qty: 5 };

describe("returnedItemQtyText with the return's kind (SA-1231)", () => {
  it("INLINE, one box of a split line: pieces with the line's own box", () => {
    expect(returnedItemQtyText({ qty: 24, kind: "INLINE", line: SPLIT_CASE })).toBe(
      "24 pcs (1 box)",
    );
  });

  it("INLINE, 5 loose pieces of a split line: 5 pcs", () => {
    expect(returnedItemQtyText({ qty: 5, kind: "INLINE", line: SPLIT_CASE })).toBe("5 pcs");
  });

  it("INLINE on a LEGACY line (sold as 1 at the box price): 24 pcs, never a bare 24", () => {
    expect(returnedItemQtyText({ qty: 24, kind: "INLINE", line: LEGACY })).toBe("24 pcs");
  });

  it("INLINE of a never-sold line: N pcs, never the current pack", () => {
    expect(returnedItemQtyText({ qty: 7, kind: "INLINE", line: null })).toBe("7 pcs");
    expect(returnedItemQtyText({ qty: 7, kind: "INLINE" })).toBe("7 pcs");
  });

  it("INLINE on a factor-1 unit line: its own word", () => {
    expect(returnedItemQtyText({ qty: 1, kind: "INLINE", line: UNIT_CASE })).toBe("1 Case");
  });

  it("STANDARD on a split line is the returns page's own text for the same item", () => {
    const item = { qty: 24, line: SPLIT_CASE };
    expect(returnedItemQtyText({ ...item, kind: "STANDARD" })).toBe(returnedItemQtyText(item));
    expect(returnedItemQtyText({ ...item, kind: "STANDARD" })).toBe("24 pcs (1 box)");
  });

  it("STANDARD with a dangling line reads the bare number the invoice prints, no throw", () => {
    expect(returnedItemQtyText({ qty: 3, kind: "STANDARD", line: null })).toBe("3");
  });

  it("without a kind nothing changes: a legacy line is the bare number, no line is pcs", () => {
    expect(returnedItemQtyText({ qty: 24, line: LEGACY })).toBe("24");
    expect(returnedItemQtyText({ qty: 24 })).toBe("24 pcs");
    expect(returnedItemQtyText({ qty: 24, line: SPLIT_CASE })).toBe("24 pcs (1 box)");
  });
});
