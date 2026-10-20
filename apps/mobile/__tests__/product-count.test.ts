import {
  buildCountRequest,
  countUnitOptions,
  previewLine,
  previewPieces,
  resultingStock,
  validateCount,
  type CountForm,
} from "../lib/product-count";

const ladder = [
  { label: "Case", factorToBase: 12 },
  { label: "Piece", factorToBase: 1 },
];
const opts = countUnitOptions({ unit: "Case", unitsPerBox: 12 }, ladder);
const base: CountForm = {
  mode: "SET",
  sign: "-",
  quantity: "3",
  unit: "Case",
  reason: "COUNT_CORRECTION",
  note: "",
  date: "",
};

describe("countUnitOptions", () => {
  it("uses the ladder when there is one", () => {
    expect(opts).toEqual([
      { label: "Case", factor: 12 },
      { label: "Piece", factor: 1 },
    ]);
  });
  it("offers the pack and pieces without a ladder", () => {
    expect(countUnitOptions({ unit: "Box", unitsPerBox: 24 })).toEqual([
      { label: "Box", factor: 24 },
      { label: "Piece", factor: 1 },
    ]);
  });
  it("offers just pieces for a product with no pack size", () => {
    expect(countUnitOptions({ unit: "kg", unitsPerBox: 1 })).toEqual([
      { label: "Piece", factor: 1 },
    ]);
  });
});

describe("preview", () => {
  it("pieces = quantity x factor, without float noise", () => {
    expect(previewPieces(3, 12)).toBe(36);
    expect(previewPieces(0.1, 3)).toBe(0.3);
  });
  it("SET shows the new count and the old one", () => {
    expect(previewLine(base, opts, 10)).toBe("Stock will be 36 pcs (was 10)");
  });
  it("ADJUST shows the arithmetic and may go negative", () => {
    const f = { ...base, mode: "ADJUST" as const, quantity: "1" };
    expect(previewLine(f, opts, 10)).toBe("Stock will be 10 − 12 = -2 pcs");
    expect(resultingStock({ ...f, sign: "+" }, opts, 10)).toBe(22);
  });
  it("has nothing to show for a blank quantity", () => {
    expect(previewLine({ ...base, quantity: "" }, opts, 10)).toBeNull();
  });
});

describe("validateCount", () => {
  it("accepts a good form", () => expect(validateCount(base, opts)).toBeNull());
  it("refuses a fractional packed unit but allows fractional pieces", () => {
    expect(validateCount({ ...base, quantity: "1.5" }, opts)).toBe(
      "Count whole cases, or switch to pieces.",
    );
    expect(validateCount({ ...base, quantity: "1.5", unit: "Piece" }, opts)).toBeNull();
  });
  it("needs a reason, and a 3+ character note for Other", () => {
    expect(validateCount({ ...base, reason: "" }, opts)).toMatch(/reason/);
    expect(validateCount({ ...base, reason: "OTHER" }, opts)).toMatch(/note/);
    expect(validateCount({ ...base, reason: "OTHER", note: "ab" }, opts)).toMatch(/note/);
    expect(validateCount({ ...base, reason: "OTHER", note: "lost" }, opts)).toBeNull();
  });
  it("SET allows zero, ADJUST does not, negatives never", () => {
    expect(validateCount({ ...base, quantity: "0" }, opts)).toBeNull();
    expect(validateCount({ ...base, mode: "ADJUST", quantity: "0" }, opts)).toMatch(/above zero/);
    expect(validateCount({ ...base, quantity: "-1" }, opts)).toMatch(/zero or more/);
  });
});

describe("buildCountRequest", () => {
  it("builds a SET body", () => {
    expect(buildCountRequest(base)).toEqual({
      mode: "SET",
      count: { unit: "Case", quantity: 3 },
      reason: "COUNT_CORRECTION",
    });
  });
  it("builds an ADJUST body with note and date", () => {
    expect(
      buildCountRequest({
        ...base,
        mode: "ADJUST",
        quantity: "1",
        reason: "OTHER",
        note: " lost ",
        date: "2026-10-01",
      }),
    ).toEqual({
      mode: "ADJUST",
      delta: { unit: "Case", quantity: 1, sign: "-" },
      reason: "OTHER",
      reasonNote: "lost",
      effectiveDate: "2026-10-01",
    });
  });
});
