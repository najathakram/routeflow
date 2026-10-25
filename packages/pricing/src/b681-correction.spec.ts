import { B661_CUTOFF } from "./legacy-box-axis";
import { computeLineCorrection, deriveLinePack } from "./b681-correction";

/**
 * B681/SA-058 through SA-076a. Red-first, direct unit tests of this module's own decision table --
 * not a reproduction of `regulated-ledger.service.ts`'s historical write-time booking algorithm
 * (that algorithm's "remaining"/"frac" state cannot be reliably reconstructed from stored rows
 * alone, which is exactly why the return-driven money path compares TRUE returned pieces rather
 * than replaying history -- see the header of `b681-correction.ts`). These cases exercise the
 * function's contract against synthetic row data, including SA-066(1)'s over-close finding that
 * overturned the first version of this module (a "fully netted, consistent-axis" reversal is that
 * bug's exact signature, not proof of correctness).
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

  it("no SALE rows at all -> clean, nothing to do, nothing parked", () => {
    expect(computeLineCorrection([], boxUnaware, sourceProvesPack12, 12)).toEqual({
      category: "clean",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      parkedReversals: [],
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
        writtenAt: null,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, null, 12);
    expect(res.category).toBe("clean");
    expect(res.corrections).toEqual([]);
    expect(res.parkedReversals).toEqual([]);
  });

  it("category A: box-axis SALE + consistent, NON-return-driven REVERSAL (e.g. a void) -- axis-only, nothing parked", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -5,
        unitBasisQty: -5,
        netSales: -120,
        categoryTax: 0,
        writtenAt: null,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A");
    expect(res.packFactor).toBe(12);
    expect(res.moneySafe).toBe(false);
    expect(res.parkedReversals).toEqual([]);
    expect(res.corrections).toEqual(
      expect.arrayContaining([
        { rowId: "s1", qtyDelta: 0, unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
        { rowId: "r1", qtyDelta: 0, unitBasisDelta: -55, netDelta: 0, taxDelta: 0 },
      ]),
    );
    expect(res.corrections).toHaveLength(2);
  });

  it("category A-piece-reversal via a NON-return-driven piece-axis reversal, NOT fully closed -- axis-only, nothing parked (no returnId to park against)", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -2,
        unitBasisQty: -30,
        netSales: -48,
        categoryTax: 0,
        writtenAt: null,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A-piece-reversal");
    expect(res.moneySafe).toBe(false);
    expect(res.parkedReversals).toEqual([]); // not return-driven -- no table row can name it
    expect(res.corrections).toEqual(
      expect.arrayContaining([
        { rowId: "s1", qtyDelta: 0, unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
        { rowId: "r1", qtyDelta: 0, unitBasisDelta: 6, netDelta: 0, taxDelta: 0 },
      ]),
    );
  });

  it("category A-piece-reversal, non-return-driven, fully closed by ONE reversal -- money already exact, delta 0", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -5,
        unitBasisQty: -60,
        netSales: -120,
        categoryTax: 0,
        writtenAt: null,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A-piece-reversal");
    expect(res.moneySafe).toBe(true);
    expect(res.corrections).toEqual([
      { rowId: "s1", qtyDelta: 0, unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
    ]);
  });

  it("category A-piece-reversal, non-return-driven, fully closed by TWO reversals with wrongly-split money -- redistributes by qty share, conserving the total", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -2,
        unitBasisQty: -20,
        netSales: -100,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r2",
        entryType: "REVERSAL" as const,
        qty: -3,
        unitBasisQty: -25,
        netSales: -20,
        categoryTax: 0,
        writtenAt: null,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.moneySafe).toBe(true);
    expect(res.corrections).toEqual(
      expect.arrayContaining([
        { rowId: "s1", qtyDelta: 0, unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
        { rowId: "r1", qtyDelta: 0, unitBasisDelta: -4, netDelta: 52, taxDelta: 0 },
        { rowId: "r2", qtyDelta: 0, unitBasisDelta: -11, netDelta: -52, taxDelta: 0 },
      ]),
    );
    const totalNetDelta = res.corrections.reduce((s, c) => s + c.netDelta, 0);
    expect(totalNetDelta).toBeCloseTo(0, 5);
  });

  it("SA-066(1): a return-driven reversal reads axis-CONSISTENT (booked -5/-5) but over-closed a partial return -- mismatch caught, money AND both quantity axes corrected", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 100,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -5,
        unitBasisQty: -5,
        netSales: -100,
        categoryTax: 0,
        writtenAt: null,
        returnEvidence: {
          returnId: "ret1",
          kind: "inline" as const,
          qtyOrPieces: 12,
          attributionUnique: true,
        },
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    // The OLD (pre-SA-076) module would have read this as category "A" (|-5|===|-5|, axis
    // "consistent") and left money untouched entirely -- exactly the silent over-close SA-066(1)
    // named. The evidence-based check must override that ratio reading.
    expect(res.category).toBe("A-piece-reversal");
    expect(res.moneySafe).toBe(true);
    expect(res.parkedReversals).toEqual([]);
    expect(res.corrections).toEqual(
      expect.arrayContaining([
        { rowId: "s1", qtyDelta: 0, unitBasisDelta: 55, netDelta: 0, taxDelta: 0 }, // 60 - 5
        {
          rowId: "r1",
          qtyDelta: 4, // target -1 (12 pieces / pack 12) - booked -5
          unitBasisDelta: -7, // target -12 - booked -5
          netDelta: 80, // target -100*(12/60)=-20 - booked -100
          taxDelta: 0,
        },
      ]),
    );
  });

  it("a return-pieces mismatch on a MULTI-reversal line -- parks every return-driven reversal on the line, including the one that matched, no money or axis correction for either", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 120,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        // this one's own booked share genuinely matches its true pieces (24)
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -2,
        unitBasisQty: -24,
        netSales: -48,
        categoryTax: 0,
        writtenAt: null,
        returnEvidence: {
          returnId: "retA",
          kind: "standard" as const,
          qtyOrPieces: 2,
          attributionUnique: true,
        },
      },
      {
        // this one over-closed: booked -3/-36 but only 12 pieces were truly returned
        id: "r2",
        entryType: "REVERSAL" as const,
        qty: -3,
        unitBasisQty: -36,
        netSales: -72,
        categoryTax: 0,
        writtenAt: null,
        returnEvidence: {
          returnId: "retB",
          kind: "inline" as const,
          qtyOrPieces: 12,
          attributionUnique: true,
        },
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A-piece-reversal");
    expect(res.moneySafe).toBe(false);
    expect(res.parkedReversals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reversalRowId: "r1", returnId: "retA", bookedShare: 24 }),
        expect.objectContaining({ reversalRowId: "r2", returnId: "retB", bookedShare: 36 }),
      ]),
    );
    expect(res.parkedReversals).toHaveLength(2);
    // Only the SALE row's axis is corrected -- neither reversal is trusted enough to axis-correct
    // on its own (r1 wasn't proven wrong, but the LINE's money question as a whole is declined).
    expect(res.corrections).toEqual([
      { rowId: "s1", qtyDelta: 0, unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
    ]);
  });

  it("return evidence unavailable (no unique matching ReturnItem) on an otherwise single-SALE/single-reversal line -- declines money, parks, no axis correction for that row", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 100,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -5,
        unitBasisQty: -5,
        netSales: -100,
        categoryTax: 0,
        writtenAt: null,
        returnEvidence: {
          returnId: "ret1",
          kind: "standard" as const,
          qtyOrPieces: null,
          attributionUnique: true,
        },
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A"); // axisOfReversal reads consistent; no mismatch was PROVEN
    expect(res.moneySafe).toBe(false);
    expect(res.parkedReversals).toEqual([
      expect.objectContaining({ reversalRowId: "r1", returnId: "ret1", bookedShare: 5 }),
    ]);
    expect(res.corrections).toEqual([
      { rowId: "s1", qtyDelta: 0, unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
    ]);
  });

  it("a return-driven reversal that PROVABLY MATCHES its true pieces -- money never in question, nothing parked", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 100,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -5,
        unitBasisQty: -60,
        netSales: -100,
        categoryTax: 0,
        writtenAt: null,
        returnEvidence: {
          returnId: "ret1",
          kind: "inline" as const,
          qtyOrPieces: 60,
          attributionUnique: true,
        },
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res.category).toBe("A"); // matched, not a mismatch -- never counted toward A-piece-reversal
    expect(res.moneySafe).toBe(false); // no branch claims credit for money that was never touched
    expect(res.parkedReversals).toEqual([]);
    expect(res.corrections).toEqual([
      { rowId: "s1", qtyDelta: 0, unitBasisDelta: 55, netDelta: 0, taxDelta: 0 },
    ]);
  });

  it("more than one SALE row on the line with a piece-axis reversal -- moneySafe refused even when net qty is 0", () => {
    const rows = [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 5,
        unitBasisQty: 5,
        netSales: 100,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "s2",
        entryType: "SALE" as const,
        qty: 2,
        unitBasisQty: 2,
        netSales: 48,
        categoryTax: 0,
        writtenAt: null,
      },
      {
        id: "r1",
        entryType: "REVERSAL" as const,
        qty: -7,
        unitBasisQty: -80,
        netSales: -148,
        categoryTax: 0,
        writtenAt: null,
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
        writtenAt: null,
      },
      {
        id: "s2",
        entryType: "SALE" as const,
        qty: 3,
        unitBasisQty: 36,
        netSales: 72,
        categoryTax: 0,
        writtenAt: null,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12);
    expect(res).toEqual({
      category: "straddles",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      parkedReversals: [],
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
        writtenAt: null,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, null, undefined);
    expect(res.category).toBe("unknown-basis");
    expect(res.corrections).toEqual([]);
    expect(res.parkedReversals).toEqual([]);
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
        writtenAt: null,
      },
    ];
    const res = computeLineCorrection(rows, boxUnaware, sourceProvesPack12, 12, [
      { qty: 0, unitBasisQty: 55 },
    ]);
    expect(res.category).toBe("clean");
    expect(res.corrections).toEqual([]);
  });

  // SA-609 / #2052: on a snapshot-less line whose product is un-boxed NOW, a ratio-1 SALE row is a box
  // count or a never-boxed quantity — only its WRITE time (createdAt vs B661_CUTOFF) says which.
  // Pre-cutoff = unknown => REPORTED (parked), NEVER corrected; post-cutoff = already pieces => clean.
  describe("SA-609 writtenAt — snapshot-less row, product un-boxed now (pack 1)", () => {
    const sale = (writtenAt: Date | string | null) => [
      {
        id: "s1",
        entryType: "SALE" as const,
        qty: 3,
        unitBasisQty: 3,
        netSales: 30,
        categoryTax: 0,
        writtenAt,
      },
    ];
    const BEFORE = new Date(B661_CUTOFF.getTime() - 24 * 3600 * 1000);
    const AFTER = new Date(B661_CUTOFF.getTime() + 24 * 3600 * 1000);

    it("written BEFORE the cutoff: unknown-basis, reported with its reason, NOTHING corrected", () => {
      const res = computeLineCorrection(sale(BEFORE), boxUnaware, null, 1);
      expect(res.category).toBe("unknown-basis");
      expect(res.corrections).toEqual([]);
      expect(res.reason).toMatch(/un-boxed|can't be told|unknown/i);
    });

    it("written AFTER the cutoff: already pieces (B661 expands boxed rows) -> clean, nothing to do", () => {
      const res = computeLineCorrection(sale(AFTER), boxUnaware, null, 1);
      expect(res.category).toBe("clean");
      expect(res.corrections).toEqual([]);
    });

    it("a row with no known write time is treated as pre-cutoff: reported, never corrected", () => {
      const res = computeLineCorrection(sale(null), boxUnaware, null, 1);
      expect(res.category).toBe("unknown-basis");
      expect(res.corrections).toEqual([]);
    });
  });
});
