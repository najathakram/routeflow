import { classifyBillLinePack, knownPackHint, productHasPackLadder } from "./bill-line-pack";

describe("bill-line-pack: classifyBillLinePack (B743 — purchase-cost silent default)", () => {
  it("repro: qty 2, unitCost 125.90, packSize null, product pack 10 -> unknown (today silently treated as pieces)", () => {
    expect(classifyBillLinePack(null, { unitsPerBox: 10 })).toBe("unknown");
  });

  it("a scanner-declined null is stored as 0 (Number(null) === 0) — 0 is ALSO unknown for a boxed product, never 'confirmed one piece'", () => {
    expect(classifyBillLinePack(0, { unitsPerBox: 10 })).toBe("unknown");
  });

  it("a stored packSize of 1 is ALSO unknown for a boxed product — 1 never means 'confirmed one piece'", () => {
    expect(classifyBillLinePack(1, { unitsPerBox: 10 })).toBe("unknown");
  });

  it("a stated pack > 1 is 'case', regardless of what the product's own ladder says", () => {
    expect(classifyBillLinePack(6, { unitsPerBox: 10 })).toBe("case");
    expect(classifyBillLinePack(6, null)).toBe("case");
  });

  it("no pack stated + no pack ladder on the product at all -> 'loose' (today's correct behavior, unaffected)", () => {
    expect(classifyBillLinePack(null, null)).toBe("loose");
    expect(classifyBillLinePack(0, { unitsPerBox: 1 })).toBe("loose");
    expect(classifyBillLinePack(undefined, { unitsPerBox: 0 })).toBe("loose");
  });

  it("a units_v1 selling ladder alone (no unitsPerBox) also makes a null pack 'unknown'", () => {
    expect(classifyBillLinePack(null, { unitsPerBox: null, units: [{ factorToBase: 24 }] })).toBe(
      "unknown",
    );
  });

  it("a ProductUnit ladder with every level at factorToBase 1 does not count as a pack ladder", () => {
    expect(classifyBillLinePack(null, { unitsPerBox: null, units: [{ factorToBase: 1 }] })).toBe(
      "loose",
    );
  });
});

describe("bill-line-pack: productHasPackLadder", () => {
  it("null/undefined product has no ladder", () => {
    expect(productHasPackLadder(null)).toBe(false);
    expect(productHasPackLadder(undefined)).toBe(false);
  });

  it("unitsPerBox > 1 alone is a ladder", () => {
    expect(productHasPackLadder({ unitsPerBox: 2 })).toBe(true);
  });

  it("any qualifying ProductUnit level is a ladder even with no unitsPerBox", () => {
    expect(
      productHasPackLadder({
        unitsPerBox: null,
        units: [{ factorToBase: 1 }, { factorToBase: 24 }],
      }),
    ).toBe(true);
  });
});

describe("bill-line-pack: knownPackHint — informational only, NEVER applied to the line", () => {
  it("prefers unitsPerBox when it qualifies", () => {
    expect(knownPackHint({ unitsPerBox: 10, units: [{ factorToBase: 24 }] })).toBe(10);
  });

  it("falls back to the smallest qualifying ProductUnit level when unitsPerBox does not qualify", () => {
    expect(
      knownPackHint({ unitsPerBox: null, units: [{ factorToBase: 24 }, { factorToBase: 6 }] }),
    ).toBe(6);
  });

  it("is 0 for a product with no pack ladder", () => {
    expect(knownPackHint({ unitsPerBox: 1 })).toBe(0);
    expect(knownPackHint(null)).toBe(0);
  });
});
