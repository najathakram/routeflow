import { buildPOLine, derivedCaseCost } from "./po-line";

describe("buildPOLine: a case line's total comes from the ENTERED case cost", () => {
  it("1,000 cases of 12 at $11.00 total exactly $11,000.00 (the per-piece route gave $11,000.40)", () => {
    const line = buildPOLine({ packSize: 12, caseCost: 11, cases: 1000 });
    expect(line.totalCost).toBe(11000);
    expect(line.qtyOrdered).toBe(12000);
    expect(line.unitCost).toBe(0.9167); // costing only, 4 dp
    expect(line.packSize).toBe(12);
    expect(line.caseCost).toBe(11);
    // the regression this replaces: pieces x the rounded per-piece cost
    expect(12000 * 0.9167).toBeCloseTo(11000.4, 6);
    expect(line.totalCost).not.toBe(11000.4);
  });

  it("the per-piece cost is NEVER multiplied back into the total", () => {
    for (const cases of [1, 7, 333, 1000, 12345]) {
      const line = buildPOLine({ packSize: 12, caseCost: 11, cases });
      expect(line.totalCost).toBe(Math.round(11 * cases * 100) / 100);
    }
  });

  it("loose pieces are prorated by the pack: 5 cases + 6 pieces of 12 at $11.00 = $60.50", () => {
    const line = buildPOLine({ packSize: 12, caseCost: 11, cases: 5, loosePieces: 6 });
    expect(line.qtyOrdered).toBe(66);
    expect(line.totalCost).toBe(60.5);
  });

  it("an awkward split rounds ONCE, at the end: 1 case + 5 pieces of 12 at $11.00 = 15.58", () => {
    expect(buildPOLine({ packSize: 12, caseCost: 11, cases: 1, loosePieces: 5 }).totalCost).toBe(
      15.58,
    );
  });

  it("loose pieces at or above the pack roll into cases", () => {
    const line = buildPOLine({ packSize: 12, caseCost: 11, cases: 1, loosePieces: 12 });
    expect(line.qtyOrdered).toBe(24);
    expect(line.totalCost).toBe(22);
  });

  it("derives the per-piece cost at 4 dp (11 / 12 = 0.9167, 24 / 24 = 1)", () => {
    expect(buildPOLine({ packSize: 12, caseCost: 11, cases: 1 }).unitCost).toBe(0.9167);
    expect(buildPOLine({ packSize: 24, caseCost: 24, cases: 1 }).unitCost).toBe(1);
    expect(buildPOLine({ packSize: 7, caseCost: 10, cases: 1 }).unitCost).toBe(1.4286);
  });

  it("a case cost with cents-and-fractions is honoured exactly (4 dp in, 2 dp out)", () => {
    expect(buildPOLine({ packSize: 12, caseCost: 11.0004, cases: 1000 }).totalCost).toBe(11000.4);
    expect(buildPOLine({ packSize: 6, caseCost: 3.3333, cases: 3 }).totalCost).toBe(10);
  });

  it("refuses inputs no valid line can have", () => {
    expect(() => buildPOLine({ packSize: 1, caseCost: 5, cases: 1 })).toThrow(RangeError);
    expect(() => buildPOLine({ packSize: 12.5, caseCost: 5, cases: 1 })).toThrow(RangeError);
    expect(() => buildPOLine({ packSize: 12, caseCost: -1, cases: 1 })).toThrow(RangeError);
    expect(() => buildPOLine({ packSize: 12, caseCost: 5, cases: 1.5 })).toThrow(RangeError);
    expect(() => buildPOLine({ packSize: 12, caseCost: 5, cases: 1, loosePieces: -2 })).toThrow(
      RangeError,
    );
    expect(() => buildPOLine({ packSize: 12, caseCost: Number.NaN, cases: 1 })).toThrow(RangeError);
  });
});

describe("buildPOLine: a per-piece line (packSize null)", () => {
  it("total = roundMoney(qty x unitCost), packSize and caseCost null", () => {
    const line = buildPOLine({ qtyOrdered: 12000, unitCost: 0.9167 });
    expect(line).toEqual({
      qtyOrdered: 12000,
      unitCost: 0.9167,
      totalCost: 11000.4,
      packSize: null,
      caseCost: null,
    });
  });

  it("decimal-unit quantities keep 3 dp", () => {
    expect(buildPOLine({ qtyOrdered: 2.5, unitCost: 4 }).totalCost).toBe(10);
    expect(buildPOLine({ qtyOrdered: 1.2345, unitCost: 1 }).qtyOrdered).toBe(1.235);
  });

  it("refuses negative or non-finite input", () => {
    expect(() => buildPOLine({ qtyOrdered: -1, unitCost: 1 })).toThrow(RangeError);
    expect(() => buildPOLine({ qtyOrdered: 1, unitCost: Number.NaN })).toThrow(RangeError);
  });
});

describe("derivedCaseCost: a stored row is shown as stored, honestly", () => {
  it("0.9167 x 12 = 11.0004 (not masked to 11.00)", () => {
    expect(derivedCaseCost(0.9167, 12)).toBe(11.0004);
  });

  it("a whole-cent case cost round-trips (1 x 24 = 24; 2.5 x 4 = 10)", () => {
    expect(derivedCaseCost(1, 24)).toBe(24);
    expect(derivedCaseCost(2.5, 4)).toBe(10);
  });

  it("a missing or invalid pack returns the per-piece cost unchanged", () => {
    expect(derivedCaseCost(0.9167, 1)).toBe(0.9167);
    expect(derivedCaseCost(0.9167, 0)).toBe(0.9167);
  });
});

describe("derivedCaseCost from the exact total (a NEW row reads back what was typed)", () => {
  it("a NEW exact row (1,000 cases stored at $11,000.00, unitCost 0.9167) reads back 11, not 11.0004", () => {
    expect(derivedCaseCost(0.9167, 12, { totalCost: 11000, qtyOrdered: 12000 })).toBe(11);
  });

  it("an OLD drifted row (total 11,000.40) reads back the honest 11.0004", () => {
    expect(derivedCaseCost(0.9167, 12, { totalCost: 11000.4, qtyOrdered: 12000 })).toBe(11.0004);
  });

  it("a row with loose pieces derives from total x pack / pieces (60.50 over 66 pieces of 12 = 11)", () => {
    expect(derivedCaseCost(0.9167, 12, { totalCost: 60.5, qtyOrdered: 66 })).toBe(11);
  });

  it("no stored total (or a zero one) falls back to unitCost x packSize", () => {
    expect(derivedCaseCost(0.9167, 12)).toBe(11.0004);
    expect(derivedCaseCost(0.9167, 12, { totalCost: null, qtyOrdered: 12000 })).toBe(11.0004);
    expect(derivedCaseCost(0.9167, 12, { totalCost: 0, qtyOrdered: 12000 })).toBe(11.0004);
  });
});
