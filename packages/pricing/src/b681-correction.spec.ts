import { computeLineCorrection, deriveLinePack } from "./b681-correction";

/**
 * B681/SA-058 through SA-073. Red-first, direct unit tests of this module's own decision table --
 * not a reproduction of `regulated-ledger.service.ts`'s historical write-time booking algorithm
 * (that algorithm's "remaining"/"frac" state cannot be reliably reconstructed from stored rows
 * alone, which is exactly why `moneySafe` is scoped as narrowly as it is -- see the header of
 * `b681-correction.ts`). These cases exercise the function's contract against synthetic row data.
 */
describe("deriveLinePack", () => {
  // qty 60 (total pieces billed) deliberately != boxes 5, so the box-count-copy evidence is
  // unambiguous (a tie between qty===boxes and qty===qty resolves to source-pieces, never this).
  const sourceWithSplit = { qty: 60, boxes: 5, pieces: 0, unitsPerBox: 12 };

  it("a full 1:1 source with boxes 5, pieces 0, line qty 5 (a box-count copy) -> factor 12", () => {
    expect(deriveLinePack({ qty: 5 }, sourceWithSplit, 12)).toEqual({ factor: 12 });
  });

  it("no source and no productPackNow -> unknown, never guessed", () => {
    expect(deriveLinePack({ qty: 5 }, null)).toEqual({
      unknown: true,
      reason: "no split on the line and no source line to check against",
    });
  });

  it("a non-integer derived factor -> unknown", () => {
    // source qty 5 doesn't match line qty 5's boxes (7) or its own qty (5)... use a source whose
    // pieces/qty ratio to the line is fractional to force a non-whole-number factor.
    expect(deriveLinePack({ qty: 4 }, { qty: 10, boxes: 2, pieces: 0, unitsPerBox: 5 })).toEqual({
      unknown: true,
      reason: "line qty (4) matches neither the source's boxes (2) nor its qty (10)",
    });
  });
});

describe("computeLineCorrection", () => {
  const boxUnaware = { boxes: null, pieces: null, unitLabel: null, unitsPerBox: null };
  // qty 60 != boxes 5, same reason as deriveLinePack's own fixture above.
  const sourceProvesPack12 = { qty: 60, boxes: 5, pieces: 0, unitsPerBox: 12 };

  it("no SALE rows at all -> clean, nothing to do", () => {
    expect(computeLineCorrection([], boxUnaware, sourceProvesPack12, 12)).toEqual({
      category: "clean",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      reason: "no SALE rows on this line",
    });
  });

  it("a SALE row already on the pieces axis -> clean, decided before pack is even derived", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 60,
        netSales: 120,
        categoryTax: 0,
      },
    ];
    // productPackNow 12 only feeds classifySaleAxis's boxed GATE here -- pack derivation never
    // runs, since "clean" short-circuits before deriveLinePack is called at all.
    const res = computeLineCorrection(rows, boxUnaware, null, 12);
    expect(res.category).toBe("clean");
    expect(res.corrections).toEqual([]);
  });

  it("category A: box-axis SALE + consistent box-axis REVERSAL -- axis-only correction for both rows", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -5,
        unitBasisQty: -5,
        netSales: -120,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A");
    expect(res.packFactor).toBe(12);
    expect(res.moneySafe).toBe(false);
    expect(res.corrections).toEqual(
      expect.arrayContaining([
        { rowId: "s1", unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
        { rowId: "r1", unitBasisDelta: -55, netDelta: 0, taxDelta: 0 },
      ]),
    );
    expect(res.corrections).toHaveLength(2);
  });

  it("category A-piece-reversal, NOT fully closed -- axis correction only, no money touched", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
      },
      // |unitBasisQty| 30 > |qty| 2 -- a piece-axis reversal against a box-axis sale
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -2,
        unitBasisQty: -30,
        netSales: -48,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A-piece-reversal");
    expect(res.moneySafe).toBe(false); // net qty is 3, still outstanding -- not fully closed
    expect(res.corrections).toEqual(
      expect.arrayContaining([
        { rowId: "s1", unitBasisDelta: 55, netDelta: 0, taxDelta: 0 }, // 60 - 5
        { rowId: "r1", unitBasisDelta: 6, netDelta: 0, taxDelta: 0 }, // -24 - (-30)
      ]),
    );
  });

  it("category A-piece-reversal, fully closed by ONE reversal -- money already exactly right, delta 0", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -5,
        unitBasisQty: -60,
        netSales: -120,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A-piece-reversal");
    expect(res.moneySafe).toBe(true);
    // r1's axis (-60) and money (-120) were already exactly right -- it needs no correction at
    // all. s1's axis still does (it's the box-axis SALE row itself: booked 5, target 60).
    expect(res.corrections).toEqual([
      { rowId: "s1", unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
    ]);
  });

  it("category A-piece-reversal, fully closed by TWO reversals with wrongly-split money -- redistributes by qty share, conserving the total", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -2,
        unitBasisQty: -20,
        netSales: -100,
        categoryTax: 0,
      },
      {
        id: "r2",
        entryType: "REVERSAL" as const,
        qty: -3,
        unitBasisQty: -25,
        netSales: -20,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A-piece-reversal");
    expect(res.moneySafe).toBe(true);
    expect(res.corrections).toEqual(
      expect.arrayContaining([
        { rowId: "s1", unitBasisDelta: 55, netDelta: 0, taxDelta: 0 }, // 60 - 5
        { rowId: "r1", unitBasisDelta: -4, netDelta: 52, taxDelta: 0 }, // ubq: -24-(-20); net: -48-(-100)
        { rowId: "r2", unitBasisDelta: -11, netDelta: -52, taxDelta: 0 }, // ubq: -36-(-25); net: -72-(-20)
      ]),
    );
    const totalNetDelta = res.corrections.reduce((s, c) => s + c.netDelta, 0);
    expect(totalNetDelta).toBeCloseTo(0, 5); // redistribution, never a net money gain/loss
  });

  it("fully closed but with an UNKNOWN-axis reversal alongside a piece-axis one -- moneySafe refused, axis still corrected", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -2,
        unitBasisQty: -30,
        netSales: -48,
        categoryTax: 0,
      }, // piece-axis
      // |unitBasisQty| 1 < |qty| 3 -- malformed, unknown axis
      {
        id: "r2",
        entryType: "REVERSAL" as const,
        qty: -3,
        unitBasisQty: -1,
        netSales: -72,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A-piece-reversal"); // r1 alone makes it so
    expect(res.moneySafe).toBe(false); // r2's unknown axis refuses the money replay
    expect(res.corrections.find((c) => c.rowId === "r2")).toEqual({
      rowId: "r2",
      unitBasisDelta: -35, // -36 - (-1)
      netDelta: 0,
      taxDelta: 0,
    });
  });

  it("more than one SALE row on the line -- moneySafe refused even when net qty is 0", () => {
    const rows = [
      // s1's qty (5) has to match sourceProvesPack12's boxes (5) for pack derivation to succeed --
      // deriveLinePack only ever reads sales[0].
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 100,
        categoryTax: 0,
      },
      {
        id: "s2",
        entryType: "SALE" as const,
        qty: 2,
        unitBasisQty: 2,
        netSales: 48,
        categoryTax: 0,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -7,
        unitBasisQty: -80,
        netSales: -148,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A-piece-reversal");
    expect(res.moneySafe).toBe(false);
    expect(res.corrections.some((c) => c.netDelta !== 0 || c.taxDelta !== 0)).toBe(false);
  });

  it("SALE rows split across both axes on one line -- straddles, never auto-corrected", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
      },
      {
        id: "s2",
        entryType: "SALE" as const,
        qty: 3,
        unitBasisQty: 36,
        netSales: 72,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res).toEqual({
      category: "straddles",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      reason: "SALE rows on this line are split across both axes -- not auto-corrected",
    });
  });

  it("no snapshot and no productPackNow -- unknown-basis, parked (classifySaleAxis's own refusal)", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, null, undefined);
    expect(res.category).toBe("unknown-basis");
    expect(res.corrections).toEqual([]);
  });

  it("a prior correction already landed this SALE row on the pieces axis -- idempotent, reads clean", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12, [
      { qty: 0, unitBasisQty: 55 },
    ]);
    expect(res.category).toBe("clean");
    expect(res.corrections).toEqual([]);
  });
});
