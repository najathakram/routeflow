import { classifySaleAxis } from "./legacy-box-axis";

/**
 * classifySaleAxis — B681/SA-058/SA-070(a). Red-first on the SA-058 synthetic rows (r1, r3, r5 —
 * the SALE rows the correction routine's own spec proves numerically) plus the corrected-row
 * idempotency case, the split/unit-line short circuits, the boxed gate's three inputs, and the
 * malformed-shape refusal. Written first so both the routine and the write-time guard import
 * this exact seam instead of drifting.
 */
describe("classifySaleAxis", () => {
  const boxUnaware = { boxes: null, pieces: null, unitLabel: null, unitsPerBox: null };

  it("r1: box-unaware, pack 12 (via productPackNow), qty 5 / unitBasisQty 5 -> legacy (box axis)", () => {
    expect(
      classifySaleAxis({ entryType: "SALE", qty: 5, unitBasisQty: 5 }, boxUnaware, [], 12),
    ).toEqual({ state: "legacy", reason: "box axis" });
  });

  it("r1 + a correction (qty 0, unitBasisQty +55) landing it on 60 -> piece-axis, not re-flagged legacy", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5 },
        boxUnaware,
        [{ qty: 0, unitBasisQty: 55 }],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "pieces axis" });
  });

  it("r3: qty 5 / unitBasisQty 60, already on the pieces axis -> piece-axis", () => {
    expect(
      classifySaleAxis({ entryType: "SALE", qty: 5, unitBasisQty: 60 }, boxUnaware, [], 12),
    ).toEqual({ state: "piece-axis", reason: "pieces axis" });
  });

  it("r5: qty 5 / unitBasisQty 5, same shape as r1 -> legacy", () => {
    expect(
      classifySaleAxis({ entryType: "SALE", qty: 5, unitBasisQty: 5 }, boxUnaware, [], 12),
    ).toEqual({ state: "legacy", reason: "box axis" });
  });

  it('split line (boxes 5): qty 60 / unitBasisQty 60 -> piece-axis, "split line" reason, short-circuits before the axis math', () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 60, unitBasisQty: 60 },
        { boxes: 5, pieces: 0, unitLabel: null, unitsPerBox: 12 },
        [],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "split line: qty is pieces by invariant" });
  });

  it('unit line ("Case"): qty 60 / unitBasisQty 60 -> piece-axis, "unit line" reason', () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 60, unitBasisQty: 60 },
        { boxes: null, pieces: null, unitLabel: "Case", unitsPerBox: null },
        [],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "unit line: qty is base units" });
  });

  it("non-boxed today (no line snapshot, productPackNow 1): qty 7 / unitBasisQty 7 -> piece-axis, not boxed", () => {
    expect(
      classifySaleAxis({ entryType: "SALE", qty: 7, unitBasisQty: 7 }, boxUnaware, [], 1),
    ).toEqual({ state: "piece-axis", reason: "not boxed — qty is already pieces" });
  });

  it("no line-level unitsPerBox snapshot AND productPackNow OMITTED entirely -> unknown, never guessed", () => {
    expect(classifySaleAxis({ entryType: "SALE", qty: 5, unitBasisQty: 5 }, boxUnaware)).toEqual({
      state: "unknown",
      reason: "no snapshot and no product to gate on",
    });
  });

  it("productPackNow explicitly null (product exists, no box size) still decides — NOT unknown", () => {
    expect(
      classifySaleAxis({ entryType: "SALE", qty: 5, unitBasisQty: 5 }, boxUnaware, [], null),
    ).toEqual({ state: "piece-axis", reason: "not boxed — qty is already pieces" });
  });

  it("line null (no invoice/order item resolved) -> unknown", () => {
    expect(classifySaleAxis({ entryType: "SALE", qty: 5, unitBasisQty: 5 }, null, [], 12)).toEqual({
      state: "unknown",
      reason: "no line to read a shape from",
    });
  });

  it("malformed: qty 5 / unitBasisQty 3 (below the qty axis, fits neither) -> unknown", () => {
    expect(
      classifySaleAxis({ entryType: "SALE", qty: 5, unitBasisQty: 3 }, boxUnaware, [], 12),
    ).toEqual({ state: "unknown", reason: "malformed — unitBasisQty is less than qty" });
  });

  it("a REVERSAL row is always unknown here — it takes its SALE's axis, never classified alone", () => {
    expect(
      classifySaleAxis({ entryType: "REVERSAL", qty: -5, unitBasisQty: -5 }, boxUnaware, [], 12),
    ).toEqual({ state: "unknown", reason: "a reversal takes its SALE's axis" });
  });

  it("Decimal-typed inputs (toString-coercible objects) answer identically to plain numbers", () => {
    const asDecimal = (n: number) => ({ toString: () => String(n), valueOf: () => n });
    const plain = classifySaleAxis(
      { entryType: "SALE", qty: 5, unitBasisQty: 5 },
      boxUnaware,
      [],
      12,
    );
    const decimal = classifySaleAxis(
      { entryType: "SALE", qty: asDecimal(5) as unknown, unitBasisQty: asDecimal(5) as unknown },
      {
        boxes: null,
        pieces: null,
        unitLabel: null,
        unitsPerBox: null,
      },
      [],
      12,
    );
    expect(decimal).toEqual(plain);
  });

  it("the line's own unitsPerBox snapshot takes priority over productPackNow when both are given", () => {
    // unitsPerBox 1 (not boxed by the snapshot) must win over a productPackNow of 12 — the sale-time
    // snapshot is authoritative; a later product change is not evidence about what this line sold as.
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5 },
        { boxes: null, pieces: null, unitLabel: null, unitsPerBox: 1 },
        [],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "not boxed — qty is already pieces" });
  });

  it("effQty <= 0 after corrections -> unknown, never legacy or piece-axis", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5 },
        boxUnaware,
        [{ qty: -5, unitBasisQty: -5 }],
        12,
      ),
    ).toEqual({ state: "unknown", reason: "corrected qty is not positive" });
  });
});
