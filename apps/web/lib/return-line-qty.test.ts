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

  it("a legacy line takes blank or a number above 0, a fraction included: the server decides", () => {
    const fractional = { qty: 2.5 };
    expect(lineCountProblem(fractional, { ...blank, qty: "1.5" })).toBeNull();
    expect(lineCountFields(fractional, { ...blank, qty: "1.5" })).toEqual({ qty: 1.5 });
    expect(lineCountProblem(fractional, blank)).toBeNull();
    expect(lineCountProblem(fractional, { ...blank, qty: "0" })).toBe("Enter a number above 0.");
    expect(lineCountProblem(fractional, { ...blank, qty: "-1" })).toBe("Enter a number above 0.");
    expect(lineCountProblem(fractional, { ...blank, qty: "3" })).toMatch(/Cannot exceed/);
  });

  it("a loose-piece return says its pieces once", () => {
    expect(returnedItemQtyText({ qty: 5, line: packLine })).toBe("5 pcs");
    expect(returnedItemQtyText({ qty: 5, line: caseLine })).toBe("5 pcs");
    expect(returnLineQtyText({ qty: 5, boxes: 0, pieces: 5 })).toBe("5 pcs");
  });

  it("reads a returned item and its ordered side back in the line's unit", () => {
    expect(returnedItemQtyText({ qty: 200, line: caseLine })).toBe("200 pcs (1 Case)");
    expect(returnedItemQtyText({ qty: 250, line: caseLine })).toBe("250 pcs (1 Case + 50 pcs)");
    expect(returnedItemQtyText({ qty: 200, line: null })).toBe("200 pcs");
    expect(returnedItemQtyText({ qty: 200 })).toBe("200 pcs");
    expect(orderedItemQtyText(caseLine)).toBe("400 pcs (2 Cases)");
    expect(orderedItemQtyText(legacy)).toBe("4");
  });
});

describe("a row says what the line knows, with one text on every spot (SA-1042 A-8)", () => {
  const over = (line: Parameters<typeof lineCountProblem>[0], field: "boxes" | "qty") =>
    lineCountProblem(line, { boxes: "", pieces: "", qty: "", [field]: "11" });

  it("G-w-a8-1: a factor-1 unit line reads its own word, one or many by the count", () => {
    const unit = { qty: 10, unitLabel: "Case", unitsPerBox: 1 };
    expect(returnedItemQtyText({ qty: 2, line: unit })).toBe("2 Cases");
    expect(returnedItemQtyText({ qty: 1, line: unit })).toBe("1 Case");
    expect(orderedItemQtyText(unit)).toBe("10 Cases");
    expect(over(unit, "boxes")).toBe("Cannot exceed what was ordered (10 Cases).");
  });

  it("G-w-a8-1: a part count on a unit line stays true, never truncated to a whole word", () => {
    const unit = { qty: 10, unitLabel: "Case", unitsPerBox: 1 };
    expect(returnedItemQtyText({ qty: 1.5, line: unit })).toBe("1.5 Case");
  });

  it.each([
    ["G-w-a8-2, snapshot 12", { qty: 10, unitsPerBox: 12 }],
    ["G-w-a8-3, null snapshot", { qty: 10, unitsPerBox: null }],
    ["G-w-a8-4, stale label on snapshot 12", { qty: 10, unitLabel: "Case", unitsPerBox: 12 }],
  ])("%s: a legacy line is the bare number, as the invoice prints it", (_name, line) => {
    expect(returnedItemQtyText({ qty: 2, line })).toBe("2");
    expect(orderedItemQtyText(line)).toBe("10");
    expect(over(line, "qty")).toBe("Cannot exceed what was ordered (10).");
  });

  it("a legacy fraction keeps its fraction", () => {
    expect(orderedItemQtyText({ qty: 2.5 })).toBe("2.5");
  });

  it("G-w-a8-5: a pooled item stays pcs", () => {
    expect(returnedItemQtyText({ qty: 2, line: null })).toBe("2 pcs");
    expect(returnedItemQtyText({ qty: 2 })).toBe("2 pcs");
  });

  it("a pieces-only split line takes its mode from lineCountMode, not from line.boxes", () => {
    const piecesOnly = { qty: 30, pieces: 30, boxes: null, unitsPerBox: 12 };
    expect(lineCountMode(piecesOnly)).toBe("split");
    expect(orderedItemQtyText(piecesOnly)).toBe("30 pcs (2 boxes + 6 pcs)");
    expect(returnedItemQtyText({ qty: 14, line: piecesOnly })).toBe("14 pcs (1 box + 2 pcs)");
  });
});
