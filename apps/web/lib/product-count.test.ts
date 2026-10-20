import {
  buildCountRequest,
  formatStockQty,
  unitDisplayLabel,
  countUnitOptions,
  previewLine,
  previewPieces,
  resultingStock,
  validateCount,
  type CountForm,
} from "./product-count";

const ladder = [
  { label: "Case", factorToBase: 12 },
  { label: "Piece", factorToBase: 1 },
];
const opts = countUnitOptions({ unit: "Case", unitsPerBox: 12 }, ladder);
const base: CountForm = {
  mode: "SET",
  sign: "-",
  quantity: "3",
  unit: "",
  reason: "COUNT_CORRECTION",
  note: "",
  date: "",
};

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
  it("sends the pack as unit null and a level or Piece by label", () => {
    const o = countUnitOptions({ unit: "jug", unitsPerBox: 12 }, [
      { label: "Case", factorToBase: 24 },
    ]);
    const send = (value: string) =>
      (buildCountRequest({ ...base, unit: value }) as { count: { unit: string | null } }).count
        .unit;
    expect(send(o[0].value)).toBeNull();
    expect(send(o[1].value)).toBe("Case");
    expect(send(o[2].value)).toBe("Piece");
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
    expect(previewLine(f, opts, 10)).toBe("Stock will be 10 − 12 = −2 pcs");
    expect(resultingStock({ ...f, sign: "+" }, opts, 10)).toBe(22);
  });
  it("uses a true minus sign for negative stock throughout", () => {
    const f = { ...base, quantity: "1", unit: "Piece" };
    expect(previewLine(f, opts, -5)).toBe("Stock will be 1 pcs (was −5)");
    expect(formatStockQty(-1234)).toBe("−1,234");
    expect(formatStockQty(1234)).toBe("1,234");
  });
  it("shows the factor-1 Piece as pcs in display text only", () => {
    expect(unitDisplayLabel({ label: "Piece", factor: 1, value: "Piece" })).toBe("pcs");
    expect(unitDisplayLabel({ label: "Case", factor: 12, value: "" })).toBe("Case");
    expect(opts[1].label).toBe("Piece");
  });
  it("has nothing to show for a blank quantity", () => {
    expect(previewLine({ ...base, quantity: "" }, opts, 10)).toBeNull();
  });
});

describe("validateCount", () => {
  it("accepts a good form", () => expect(validateCount(base, opts)).toBeNull());
  it("refuses a fractional packed unit but allows fractional pieces", () => {
    expect(validateCount({ ...base, quantity: "1.5" }, opts)).toBe(
      "Use a whole number, or switch to pcs.",
    );
    expect(validateCount({ ...base, quantity: "1.5", unit: "Piece" }, opts)).toBeNull();
  });
  it("needs a reason, and a 3+ character note for Other", () => {
    expect(validateCount({ ...base, reason: "" }, opts)).toBe("Pick a reason.");
    expect(validateCount({ ...base, reason: "OTHER" }, opts)).toBe("Add a note for Other.");
    expect(validateCount({ ...base, reason: "OTHER", note: "ab" }, opts)).toBe(
      "Add a note for Other.",
    );
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
      count: { unit: null, quantity: 3 },
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
      delta: { unit: null, quantity: 1, sign: "-" },
      reason: "OTHER",
      reasonNote: "lost",
      effectiveDate: "2026-10-01",
    });
  });
});
