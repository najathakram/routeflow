import { readFileSync } from "fs";
import { resolve } from "path";
import {
  belowZeroWarning,
  buildCountRequest,
  countParts,
  countUnitOptions,
  formatStockQty,
  noteHint,
  previewLines,
  reasonHint,
  resultingStock,
  rowProblem,
  validateCount,
  type CountForm,
} from "./product-count";

const ladder = [
  { label: "Case", factorToBase: 12 },
  { label: "Piece", factorToBase: 1 },
];
const opts = countUnitOptions({ unit: "Case", unitsPerBox: 12 }, ladder);
// 12-pack "jug" with a Case of 24: rows jug (12) / Case (24) / Piece (1)
const jugs = countUnitOptions({ unit: "jug", unitsPerBox: 12 }, [
  { label: "Case", factorToBase: 24 },
]);
const base: CountForm = {
  mode: "SET",
  sign: "-",
  quantities: { "": "3" },
  reason: "COUNT_CORRECTION",
  note: "",
  date: "",
};
const q = (quantities: Record<string, string>, over: Partial<CountForm> = {}): CountForm => ({
  ...base,
  quantities,
  ...over,
});

describe("countUnitOptions", () => {
  it("uses the ladder when there is one", () => {
    expect(opts).toEqual([
      { label: "Case", factor: 12, value: "" },
      { label: "Piece", factor: 1, value: "Piece" },
    ]);
  });
  it("keeps the pack, the levels and Piece for a 12-pack with a Case of 24", () => {
    const o = countUnitOptions({ unit: "jug", unitsPerBox: 12 }, [
      { label: "Case", factorToBase: 24 },
    ]);
    expect(o).toEqual([
      { label: "jug", factor: 12, value: "" },
      { label: "Case", factor: 24, value: "Case" },
      { label: "Piece", factor: 1, value: "Piece" },
    ]);
  });
  it("names the pack, the levels and the base word as rows, in that order", () => {
    const o = countUnitOptions({ unit: "jug", unitsPerBox: 12 }, [
      { label: "Case", factorToBase: 24 },
    ]);
    expect(o.map((x) => x.value)).toEqual(["", "Case", "Piece"]);
  });
  it("shadows a level row named like the pack", () => {
    const o = countUnitOptions({ unit: "jug", unitsPerBox: 12 }, [
      { label: "JUG", factorToBase: 24 },
    ]);
    expect(o.filter((x) => x.label.toLowerCase() === "jug")).toHaveLength(1);
    expect(o[0].factor).toBe(12);
  });
  it("offers a single option for a loose product", () => {
    expect(countUnitOptions({ unit: "kg", unitsPerBox: 1 }, [])).toHaveLength(1);
  });
  it("offers the pack and pieces without a ladder", () => {
    expect(countUnitOptions({ unit: "Box", unitsPerBox: 24 })).toEqual([
      { label: "Box", factor: 24, value: "" },
      { label: "Piece", factor: 1, value: "Piece" },
    ]);
  });
  it("offers just pieces for a product with no pack size", () => {
    expect(countUnitOptions({ unit: "kg", unitsPerBox: 1 })).toEqual([
      { label: "kg", factor: 1, value: "" },
    ]);
  });
});

describe("countParts (one row per unit; blank = 0 and is not sent)", () => {
  it("keeps the typed rows in the options' order, zero included", () => {
    expect(countParts(q({ Piece: "4", "": "3", Case: "" }), jugs)).toEqual([
      { option: jugs[0], quantity: 3 },
      { option: jugs[2], quantity: 4 },
    ]);
    expect(countParts(q({ "": "0" }), jugs)).toEqual([{ option: jugs[0], quantity: 0 }]);
  });
  it("ignores unparsable text (the row's own problem says so)", () => {
    expect(countParts(q({ "": "abc" }), jugs)).toEqual([]);
  });
});

describe("preview (the arithmetic is @routeflow/pricing's countPieces)", () => {
  it('parity with the API\'s piecesOf: "3 Case + 4 jug" on 24 / 12 = 120', () => {
    expect(resultingStock(q({ Case: "3", "": "4" }), jugs, 0)).toBe(120);
  });
  it("parity with the API's piecesOf table: 3-place base quantity, pack of 1, pack of null", () => {
    const each = countUnitOptions({ unit: "Each", unitsPerBox: null }, []);
    expect(resultingStock(q({ "": "0.125" }), each, 0)).toBe(0.125);
    expect(
      resultingStock(q({ "": "7" }), countUnitOptions({ unit: "Each", unitsPerBox: 1 }), 0),
    ).toBe(7);
    expect(
      resultingStock(
        q({ "": "2", Piece: "2.5" }),
        countUnitOptions({ unit: "Box", unitsPerBox: 12 }, [{ label: "Case", factorToBase: 24 }]),
        0,
      ),
    ).toBe(26.5);
  });
  it("SET shows the new count (in the base word) and the old one", () => {
    expect(previewLines(base, opts, 10)).toEqual(["Stock will be 36 Pieces (was 10)"]);
  });
  it("ADJUST shows the arithmetic and may go negative", () => {
    const f = q({ "": "1" }, { mode: "ADJUST" });
    expect(previewLines(f, opts, 10)).toEqual(["Stock will be 10 − 12 = −2 Pieces"]);
    expect(resultingStock({ ...f, sign: "+" }, opts, 10)).toBe(22);
  });
  it("with two or more non-zero rows the parts come first, as the movement note names them", () => {
    expect(previewLines(q({ Case: "3", "": "4" }), jugs, 88)).toEqual([
      "4 jug (×12) + 3 Case (×24) = 120 Pieces",
      "Stock will be 120 Pieces (was 88)",
    ]);
    expect(previewLines(q({ Case: "1", "": "0" }, { mode: "ADJUST" }), jugs, 88)).toEqual([
      "Stock will be 88 − 24 = 64 Pieces",
    ]);
  });
  it("says One Piece in the singular and a loose product's own word, pluralised", () => {
    expect(previewLines(q({ Piece: "1" }), jugs, 5)[0]).toBe("Stock will be 1 Piece (was 5)");
    const bags = countUnitOptions({ unit: "bag", unitsPerBox: 1 }, []);
    expect(previewLines(q({ "": "10" }), bags, 4)).toEqual(["Stock will be 10 bags (was 4)"]);
  });
  it("uses a true minus sign for negative stock throughout", () => {
    expect(previewLines(q({ Piece: "1" }), jugs, -5)).toEqual(["Stock will be 1 Piece (was −5)"]);
    expect(formatStockQty(-1234)).toBe("−1,234");
    expect(formatStockQty(1234)).toBe("1,234");
  });
  it("has nothing to show while every row is blank", () => {
    expect(previewLines(q({}), jugs, 10)).toEqual([]);
  });
});

describe("belowZeroWarning (a result under zero is said, not blocked)", () => {
  const remove = (n: string) => q({ "": n }, { mode: "ADJUST", sign: "-" });
  it("SA-958 red row: 40 on hand, Remove 48 names the shortfall in the base word", () => {
    expect(belowZeroWarning(remove("4"), opts, 40)).toBe(
      "This takes stock below zero (−8 Pieces).",
    );
  });
  it("is silent at exactly zero, above zero, for a SET, and with nothing typed", () => {
    expect(belowZeroWarning(remove("1"), opts, 12)).toBeNull();
    expect(belowZeroWarning(remove("1"), opts, 40)).toBeNull();
    expect(belowZeroWarning(q({ "": "0" }), opts, 40)).toBeNull();
    expect(belowZeroWarning(q({}, { mode: "ADJUST" }), opts, 40)).toBeNull();
  });
});

describe("reasonHint / noteHint (each message sits under its own field)", () => {
  it("asks for a reason until one is chosen", () => {
    expect(reasonHint({ ...base, reason: "" })).toBe("Pick a reason.");
    expect(reasonHint(base)).toBeNull();
  });
  it("asks for a note only for Other, 3-200 characters", () => {
    expect(noteHint({ ...base, reason: "OTHER", note: "ab" })).toBe("Add a note for Other.");
    expect(noteHint({ ...base, reason: "OTHER", note: "abc" })).toBeNull();
    expect(noteHint({ ...base, reason: "DAMAGED", note: "" })).toBeNull();
  });
});

describe("rowProblem (under its own row)", () => {
  it("refuses a fractional packed unit and names the base word; allows fractional pieces", () => {
    expect(rowProblem(jugs[1], "1.5", jugs)).toBe(
      "Count whole cases, or count the rest in pieces.",
    );
    expect(rowProblem(jugs[2], "1.5", jugs)).toBeNull();
  });
  it("refuses a negative; blank is fine", () => {
    expect(rowProblem(jugs[0], "-1", jugs)).toMatch(/zero or more/);
    expect(rowProblem(jugs[0], "", jugs)).toBeNull();
  });
});

describe("validateCount", () => {
  it("accepts a good form", () => expect(validateCount(base, opts)).toBeNull());
  it("SET needs at least one row; zero is a real count", () => {
    expect(validateCount(q({}), opts)).toBe("Enter a count.");
    expect(validateCount(q({ "": "0" }), opts)).toBeNull();
  });
  it("ADJUST needs a quantity above zero in some row", () => {
    expect(validateCount(q({}, { mode: "ADJUST" }), opts)).toBe("Enter a quantity.");
    expect(validateCount(q({ "": "0", Piece: "" }, { mode: "ADJUST" }), opts)).toMatch(
      /above zero/,
    );
    expect(validateCount(q({ "": "0", Piece: "2" }, { mode: "ADJUST" }), opts)).toBeNull();
  });
  it("a row's problem blocks Save", () => {
    expect(validateCount(q({ "": "1.5" }), opts)).toMatch(/Count whole/);
    expect(validateCount(q({ "": "-1" }), opts)).toMatch(/zero or more/);
  });
  it("needs a reason, and a 3+ character note for Other", () => {
    expect(validateCount({ ...base, reason: "" }, opts)).toBe("Pick a reason.");
    expect(validateCount({ ...base, reason: "OTHER" }, opts)).toBe("Add a note for Other.");
    expect(validateCount({ ...base, reason: "OTHER", note: "lost" }, opts)).toBeNull();
  });
});

describe("buildCountRequest", () => {
  it("sends one part per non-blank row: the pack as unit null, a level or Piece by label", () => {
    expect(buildCountRequest(q({ Case: "3", "": "4", Piece: "" }), jugs) as unknown).toEqual({
      mode: "SET",
      parts: [
        { unit: null, quantity: 4 },
        { unit: "Case", quantity: 3 },
      ],
      reason: "COUNT_CORRECTION",
    });
  });
  it("an ADJUST carries one sign for the whole delta", () => {
    expect(
      buildCountRequest(
        q(
          { Case: "1", Piece: "2" },
          { mode: "ADJUST", sign: "-", reason: "OTHER", note: " lost ", date: "2026-10-01" },
        ),
        jugs,
      ),
    ).toEqual({
      mode: "ADJUST",
      parts: [
        { unit: "Case", quantity: 1 },
        { unit: "Piece", quantity: 2 },
      ],
      sign: "-",
      reason: "OTHER",
      reasonNote: "lost",
      effectiveDate: "2026-10-01",
    });
  });
});

describe("no second copy of the count math (SA-957 M2: one rule in @routeflow/pricing)", () => {
  const src = readFileSync(resolve(__dirname, "product-count.ts"), "utf8");
  it("takes its factor and its sum from countFactorOf / countPieces", () => {
    expect(src).toMatch(/countFactorOf\(/);
    expect(src).toMatch(/countPieces\(/);
  });
  it("has no local factor rule, rounding, or pieces-multiplication of its own", () => {
    expect(src).not.toMatch(/1e6/);
    expect(src).not.toMatch(/previewPieces/);
    expect(src).not.toMatch(/factorToBase\s*<=\s*1/);
  });
});
