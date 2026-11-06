import { computeLineCorrection, deriveLinePack } from "./b681-correction";
import { B661_CUTOFF } from "./legacy-box-axis";

/**
 * SA-1088 review rows on the ported classifier (#4140 review-a, hold 3). `b681-correction.spec.ts` is the unedited
 * port (QD-1); these rows pin the four decisions its standard rows leave open, each on a line where the OUTCOME
 * changes if the decision is wrong: the standard return is multiplied by the pack and an inline one is not, a shared
 * return item is never trusted, the booked share is capped at the whole sale, and a non-whole pack is refused.
 */
const boxUnaware = { boxes: null, pieces: null, unitLabel: null, unitsPerBox: null };
const source12 = { qty: 60, boxes: 5, pieces: 0, unitsPerBox: 12 };
const before = new Date(B661_CUTOFF.getTime() - 86_400_000);

const sale = {
  id: "s1",
  entryType: "SALE" as const,
  qty: 5,
  unitBasisQty: 5,
  netSales: 100,
  categoryTax: 10,
  writtenAt: before,
};
const saleRow = sale;
const reversal = (o: Record<string, unknown> = {}) => ({
  id: "v1",
  entryType: "REVERSAL" as const,
  qty: -2,
  unitBasisQty: -24,
  netSales: -40,
  categoryTax: -4,
  writtenAt: before,
  returnEvidence: {
    returnId: "ret1",
    kind: "standard" as const,
    qtyOrPieces: 2,
    attributionUnique: true,
  },
  ...o,
});

describe("computeLineCorrection: the return evidence rows", () => {
  it("R1: a STANDARD return item is multiplied by the pack (2 boxes x 12 = the 24 pieces booked)", () => {
    const res = computeLineCorrection([saleRow, reversal()], boxUnaware, source12, 12);
    expect(res.category).toBe("A");
    expect(res.parkedReversals).toEqual([]);
    // the reversal already matches its return: only the sale moves (5 boxes -> 60 pieces), nothing about money
    expect(res.corrections.map((c) => c.rowId)).toEqual(["s1"]);
    expect(res.corrections[0].netDelta).toBe(0);
  });

  it("R2: an INLINE return's pieces are NOT multiplied (24 pieces booked = 24 pieces returned)", () => {
    const res = computeLineCorrection(
      [
        saleRow,
        reversal({
          returnEvidence: {
            returnId: "ret1",
            kind: "inline",
            qtyOrPieces: 24,
            attributionUnique: true,
          },
        }),
      ],
      boxUnaware,
      source12,
      12,
    );
    expect(res.category).toBe("A");
    expect(res.parkedReversals).toEqual([]);
    expect(res.corrections.map((c) => c.rowId)).toEqual(["s1"]);
  });

  it("R3: evidence shared by two reversals is never trusted, even when its figure matches: parked", () => {
    const res = computeLineCorrection(
      [
        saleRow,
        reversal({
          returnEvidence: {
            returnId: "ret1",
            kind: "standard",
            qtyOrPieces: 2,
            attributionUnique: false,
          },
        }),
      ],
      boxUnaware,
      source12,
      12,
    );
    expect(res.moneySafe).toBe(false);
    expect(res.parkedReversals.map((p) => p.reversalRowId)).toEqual(["v1"]);
  });

  it("R4: a return larger than the sale books at most the WHOLE sale (the share is capped at 1)", () => {
    // 7 boxes came back on a 5 box sale; the reversal was booked at 24 pieces, so it mismatches. Net sale 100:
    // the resolved reversal is -100 (all of it), which is 60 more than the -40 booked.
    const res = computeLineCorrection(
      [
        saleRow,
        reversal({
          returnEvidence: {
            returnId: "ret1",
            kind: "standard",
            qtyOrPieces: 7,
            attributionUnique: true,
          },
        }),
      ],
      boxUnaware,
      source12,
      12,
    );
    expect(res.moneySafe).toBe(true);
    const c = res.corrections.find((x) => x.rowId === "v1");
    expect(c?.netDelta).toBe(-60);
    expect(c?.taxDelta).toBe(-6);
  });
});

describe("deriveLinePack: a pack must be a whole number of pieces per unit", () => {
  it("R5: 50 pieces over a 4 unit line is 12.5 per unit: unknown, never rounded", () => {
    const res = deriveLinePack({ qty: 4 }, { qty: 50, boxes: 4, pieces: 0, unitsPerBox: 12 }, 12);
    expect(res).toEqual({
      unknown: true,
      reason: expect.stringMatching(/not a whole number/),
    });
  });
});
