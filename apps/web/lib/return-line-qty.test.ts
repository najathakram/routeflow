import { returnLineQtyText } from "./return-line-qty";

describe("returnLineQtyText (SA-1042 B9a)", () => {
  it("a Case line reads pieces with its Cases", () => {
    expect(returnLineQtyText({ qty: 400, boxes: 2, pieces: 0, unitLabel: "Case" })).toBe(
      "400 pcs (2 Cases)",
    );
    expect(returnLineQtyText({ qty: 200, boxes: 1, pieces: 0, unitLabel: "Case" })).toBe(
      "200 pcs (1 Case)",
    );
  });
  it("a pack line reads pieces with its boxes, and a mixed split names both", () => {
    expect(returnLineQtyText({ qty: 100, boxes: 10, pieces: 0 })).toBe("100 pcs (10 boxes)");
    expect(returnLineQtyText({ qty: 25, boxes: 2, pieces: 5 })).toBe("25 pcs (2 boxes + 5 pcs)");
  });
  it("a line with no split is plain pieces, a factor-1 unit line too", () => {
    expect(returnLineQtyText({ qty: 12 })).toBe("12 pcs");
    expect(returnLineQtyText({ qty: "12.000", boxes: null, pieces: null })).toBe("12 pcs");
    expect(returnLineQtyText({ qty: 5, unitLabel: "Piece" })).toBe("5 pcs");
  });
  it("takes the words from the line's label, never a default for a custom unit", () => {
    expect(returnLineQtyText({ qty: 960, boxes: 2, pieces: 0, unitLabel: "Pallet" })).toBe(
      "960 pcs (2 Pallets)",
    );
  });
});
