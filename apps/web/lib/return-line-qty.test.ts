import {
  lineCountFields,
  lineCountMode,
  lineCountProblem,
  lineUnitWords,
  orderedItemQtyText,
  returnedItemQtyText,
  returnLineQtyText,
} from "./return-line-qty";

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

describe("counting a return by line (SA-1042 B9c)", () => {
  const caseLine = { qty: 400, boxes: 2, pieces: 0, unitsPerBox: 200, unitLabel: "Case" };
  const packLine = { qty: 100, boxes: 10, pieces: 0, unitsPerBox: 10 };
  const unitLine = { qty: 5, unitLabel: "Piece", unitsPerBox: 1 };
  const legacy = { qty: 4, unitsPerBox: 12 };
  const blank = { boxes: "", pieces: "", qty: "" };

  it("picks the count shape the server uses", () => {
    expect(lineCountMode(caseLine)).toBe("split");
    expect(lineCountMode(packLine)).toBe("split");
    expect(lineCountMode(unitLine)).toBe("unit");
    expect(lineCountMode(legacy)).toBe("legacy");
  });

  it("words come from the line's snapshot", () => {
    expect(lineUnitWords(caseLine)).toEqual({ one: "Case", many: "Cases" });
    expect(lineUnitWords(packLine)).toEqual({ one: "box", many: "boxes" });
  });

  it("the payload fields are in the line's own unit, null when nothing is returned", () => {
    expect(lineCountFields(caseLine, { ...blank, boxes: "1" })).toEqual({ boxes: 1, pieces: 0 });
    expect(lineCountFields(packLine, { ...blank, boxes: "3", pieces: "2" })).toEqual({
      boxes: 3,
      pieces: 2,
    });
    expect(lineCountFields(unitLine, { ...blank, boxes: "3", pieces: "9" })).toEqual({
      boxes: 3,
      pieces: 0,
    });
    expect(lineCountFields(legacy, { ...blank, qty: "2" })).toEqual({ qty: 2 });
    expect(lineCountFields(caseLine, blank)).toBeNull();
    expect(lineCountFields(legacy, { ...blank, boxes: "5" })).toBeNull();
  });

  it("flags a count over the line, a fraction, and says nothing for a good one", () => {
    expect(lineCountProblem(caseLine, { ...blank, boxes: "2" })).toBeNull();
    expect(lineCountProblem(caseLine, { ...blank, boxes: "2", pieces: "1" })).toMatch(
      /Cannot exceed what was ordered \(400 pcs \(2 Cases\)\)/,
    );
    expect(lineCountProblem(caseLine, { ...blank, boxes: "1.5" })).toBe("Use whole numbers.");
    expect(lineCountProblem(legacy, { ...blank, qty: "5" })).toMatch(/Cannot exceed/);
    expect(lineCountProblem(caseLine, blank)).toBeNull();
  });

  it("reads a returned item and its ordered side back in the line's unit", () => {
    expect(returnedItemQtyText({ qty: 200, line: caseLine })).toBe("200 pcs (1 Case)");
    expect(returnedItemQtyText({ qty: 250, line: caseLine })).toBe("250 pcs (1 Case + 50 pcs)");
    expect(returnedItemQtyText({ qty: 200, line: null })).toBe("200 pcs");
    expect(returnedItemQtyText({ qty: 200 })).toBe("200 pcs");
    expect(orderedItemQtyText(caseLine)).toBe("400 pcs (2 Cases)");
    expect(orderedItemQtyText(legacy)).toBe("4 pcs");
  });
});
