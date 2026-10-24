import { B661_CUTOFF, classifySaleAxis } from "./legacy-box-axis";

/**
 * classifySaleAxis — B681/SA-058/SA-070(a). Red-first on the SA-058 synthetic rows (r1, r3, r5 —
 * the SALE rows the correction routine's own spec proves numerically) plus the corrected-row
 * idempotency case, the split/unit-line short circuits, the boxed gate's three inputs, and the
 * malformed-shape refusal. Written first so both the routine and the write-time guard import
 * this exact seam instead of drifting.
 */
describe("classifySaleAxis", () => {
  const boxUnaware = { boxes: null, pieces: null, unitLabel: null, unitsPerBox: null };
  const BEFORE_CUTOFF = new Date(B661_CUTOFF.getTime() - 24 * 3600 * 1000);
  const AFTER_CUTOFF = new Date(B661_CUTOFF.getTime() + 24 * 3600 * 1000);

  it("r1: box-unaware, pack 12 (via productPackNow), qty 5 / unitBasisQty 5 -> legacy (box axis)", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        12,
      ),
    ).toEqual({ state: "legacy", reason: "box axis" });
  });

  it("r1 + a correction (qty 0, unitBasisQty +55) landing it on 60 -> piece-axis, not re-flagged legacy", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [{ qty: 0, unitBasisQty: 55 }],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "pieces axis" });
  });

  it("r3: qty 5 / unitBasisQty 60, already on the pieces axis -> piece-axis", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 60, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "pieces axis" });
  });

  it("r5: qty 5 / unitBasisQty 5, same shape as r1 -> legacy", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        12,
      ),
    ).toEqual({ state: "legacy", reason: "box axis" });
  });

  it('split line (boxes 5): qty 60 / unitBasisQty 60 -> piece-axis, "split line" reason, short-circuits before the axis math', () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 60, unitBasisQty: 60, writtenAt: AFTER_CUTOFF },
        { boxes: 5, pieces: 0, unitLabel: null, unitsPerBox: 12 },
        [],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "split line: qty is pieces by invariant" });
  });

  it('unit line ("Case"): qty 60 / unitBasisQty 60 -> piece-axis, "unit line" reason', () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 60, unitBasisQty: 60, writtenAt: AFTER_CUTOFF },
        { boxes: null, pieces: null, unitLabel: "Case", unitsPerBox: null },
        [],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "unit line: qty is base units" });
  });

  it("never-boxed line written AFTER B661 (no snapshot, productPackNow 1): qty 7 / unitBasisQty 7 -> piece-axis, not boxed", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 7, unitBasisQty: 7, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        1,
      ),
    ).toEqual({ state: "piece-axis", reason: "not boxed — qty is already pieces" });
  });

  it("no line-level unitsPerBox snapshot AND productPackNow OMITTED entirely -> unknown, never guessed", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        boxUnaware,
      ),
    ).toEqual({
      state: "unknown",
      reason: "no snapshot and no product to gate on",
    });
  });

  it("productPackNow explicitly null (product exists, no box size) still decides — NOT unknown", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        null,
      ),
    ).toEqual({ state: "piece-axis", reason: "not boxed — qty is already pieces" });
  });

  it("line null (no invoice/order item resolved) -> unknown", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        null,
        [],
        12,
      ),
    ).toEqual({
      state: "unknown",
      reason: "no line to read a shape from",
    });
  });

  it("malformed: qty 5 / unitBasisQty 3 (below the qty axis, fits neither) -> unknown", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 3, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        12,
      ),
    ).toEqual({ state: "unknown", reason: "malformed — unitBasisQty is less than qty" });
  });

  it("a REVERSAL row is always unknown here — it takes its SALE's axis, never classified alone", () => {
    expect(
      classifySaleAxis(
        { entryType: "REVERSAL", qty: -5, unitBasisQty: -5, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        12,
      ),
    ).toEqual({ state: "unknown", reason: "a reversal takes its SALE's axis" });
  });

  it("Decimal-typed inputs (toString-coercible objects) answer identically to plain numbers", () => {
    const asDecimal = (n: number) => ({ toString: () => String(n), valueOf: () => n });
    const plain = classifySaleAxis(
      { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
      boxUnaware,
      [],
      12,
    );
    const decimal = classifySaleAxis(
      {
        entryType: "SALE",
        qty: asDecimal(5) as unknown,
        unitBasisQty: asDecimal(5) as unknown,
        writtenAt: AFTER_CUTOFF,
      },
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
        { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        { boxes: null, pieces: null, unitLabel: null, unitsPerBox: 1 },
        [],
        12,
      ),
    ).toEqual({ state: "piece-axis", reason: "not boxed — qty is already pieces" });
  });

  it("effQty <= 0 after corrections -> unknown, never legacy or piece-axis", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [{ qty: -5, unitBasisQty: -5 }],
        12,
      ),
    ).toEqual({ state: "unknown", reason: "corrected qty is not positive" });
  });

  it("SA-073: a non-finite row qty (a non-numeric string) -> unknown, never silently defaults", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: "x", unitBasisQty: 5, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        12,
      ),
    ).toEqual({ state: "unknown", reason: "row qty/unitBasisQty is not a usable number" });
  });

  it("SA-073: a non-finite row unitBasisQty (NaN) -> unknown, never silently defaults", () => {
    expect(
      classifySaleAxis(
        { entryType: "SALE", qty: 5, unitBasisQty: NaN, writtenAt: AFTER_CUTOFF },
        boxUnaware,
        [],
        12,
      ),
    ).toEqual({ state: "unknown", reason: "row qty/unitBasisQty is not a usable number" });
  });
  // SA-609 / #2052: a snapshot-less line's live pack may no longer short-circuit to piece-axis —
  // a product un-boxed AFTER the sale reads "not boxed" though the row sold N boxes (box axis).
  describe("#2052 — snapshot-less line, product un-boxed since the sale", () => {
    const sale = (qty: number, ubq: number, writtenAt: Date | string | null = BEFORE_CUTOFF) => ({
      entryType: "SALE",
      qty,
      unitBasisQty: ubq,
      writtenAt,
    });

    it.each([1, null])(
      "REG-2052: pre-cutoff 3/3, pack now %s -> unknown (parks), NOT piece-axis (would book 3 pieces of 36)",
      (packNow) => {
        expect(classifySaleAxis(sale(3, 3), boxUnaware, [], packNow).state).toBe("unknown");
      },
    );

    it("the same 3/3 row written AFTER the cutoff -> piece-axis (B661 would have written 36)", () => {
      expect(classifySaleAxis(sale(3, 3, AFTER_CUTOFF), boxUnaware, [], 1)).toEqual({
        state: "piece-axis",
        reason: "not boxed — qty is already pieces",
      });
    });

    it("pins B661_CUTOFF to the verified deploy instant (SA-791)", () => {
      expect(B661_CUTOFF.toISOString()).toBe("2026-09-23T06:43:26.000Z");
    });

    it("a createdAt string on the cutoff instant counts as AFTER (boundary: < cutoff parks)", () => {
      expect(classifySaleAxis(sale(3, 3, B661_CUTOFF.toISOString()), boxUnaware, [], 1).state).toBe(
        "piece-axis",
      );
      expect(
        classifySaleAxis(sale(3, 3, new Date(B661_CUTOFF.getTime() - 1)), boxUnaware, [], 1).state,
      ).toBe("unknown");
    });

    it.each([
      ["null", null],
      ["an unparseable string", "not-a-date"],
    ])("writtenAt %s -> unknown write time reads as pre-cutoff: parks", (_l, writtenAt) => {
      expect(classifySaleAxis(sale(3, 3, writtenAt as never), boxUnaware, [], 1).state).toBe(
        "unknown",
      );
    });

    it("36/3 (already expanded) with pack now 1 -> piece-axis at any time", () => {
      expect(classifySaleAxis(sale(3, 36), boxUnaware, [], 1).state).toBe("piece-axis");
      expect(classifySaleAxis(sale(3, 36, AFTER_CUTOFF), boxUnaware, [], 1).state).toBe(
        "piece-axis",
      );
    });

    it("pack now 12 with ratio 1 -> legacy, unchanged, at any time", () => {
      expect(classifySaleAxis(sale(3, 3), boxUnaware, [], 12).state).toBe("legacy");
      expect(classifySaleAxis(sale(3, 3, AFTER_CUTOFF), boxUnaware, [], 12).state).toBe("legacy");
    });

    it("a line WITH a unitsPerBox snapshot is unchanged whatever the time or live pack", () => {
      const snap1 = { ...boxUnaware, unitsPerBox: 1 };
      const snap12 = { ...boxUnaware, unitsPerBox: 12 };
      expect(classifySaleAxis(sale(3, 3), snap1, [], 12).state).toBe("piece-axis");
      expect(classifySaleAxis(sale(3, 3), snap1, [], 1).state).toBe("piece-axis");
      expect(classifySaleAxis(sale(3, 3), snap12, [], 1).state).toBe("legacy");
    });

    it("corrections fold: a pre-cutoff 3/3 row already corrected to 36 is never re-parked", () => {
      expect(
        classifySaleAxis(sale(3, 3), boxUnaware, [{ qty: 0, unitBasisQty: 33 }], 1).state,
      ).toBe("piece-axis");
    });

    it("a zeroed row (qty 0/0) or a malformed one on an un-boxed product keeps today's piece-axis — never newly parks", () => {
      expect(classifySaleAxis(sale(0, 0), boxUnaware, [], 1).state).toBe("piece-axis");
      expect(classifySaleAxis(sale(5, 3), boxUnaware, [], null).state).toBe("piece-axis");
    });

    it("pack now OMITTED with no snapshot -> unknown, as today", () => {
      expect(classifySaleAxis(sale(3, 3, AFTER_CUTOFF), boxUnaware).state).toBe("unknown");
    });
  });
});
