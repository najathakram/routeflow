import { MovementType, Prisma } from "@prisma/client";
import { interposeOrder, type LegacyOrder } from "./d2-interpose";
import { reconstruct, type LedgerRow } from "./d2-reconstruct";
import { foldLedger } from "../fold-ledger";

/**
 * Row 635 PR B (SA-136 §5 D2, SA-373, SA-902 MUSTs 3-5): the pure half of the AVCO average repair.
 * `interposeOrder` places a legacy order's stock events on the counter's clock with their uncertainty windows;
 * `reconstruct` folds the ledger (minus the D1 anchor) plus those events plus the residual through THE fold.
 */
const D = (v: number | string) => new Prisma.Decimal(v);
const T = (iso: string) => new Date(iso);
const CUT = T("2026-09-24T00:00:00.000Z");

let seq = 0;
const row = (
  type: MovementType,
  qty: number,
  at: string,
  extra: Partial<LedgerRow> = {},
): LedgerRow => {
  seq += 1;
  return {
    id: `r${String(seq).padStart(3, "0")}`,
    type,
    quantity: D(qty),
    unitCost: extra.unitCost ?? null,
    reference: extra.reference ?? null,
    effectiveAt: T(at),
    createdAt: extra.createdAt ?? T(at),
  };
};
const buy = (qty: number, cost: number, at: string) =>
  row(MovementType.PURCHASE, qty, at, { unitCost: D(cost) });
const anchor = (qty: number) =>
  row(MovementType.SALE, qty, CUT.toISOString(), {
    reference: "B562:BACKFILL:h1",
    createdAt: T("2026-10-20T00:00:00.000Z"),
  });

const order = (o: Partial<LegacyOrder> & Pick<LegacyOrder, "lines">): LegacyOrder => ({
  id: o.id ?? "o1",
  status: o.status ?? "DELIVERED",
  createdAt: o.createdAt ?? T("2026-09-05T00:00:00.000Z"),
  updatedAt: o.updatedAt ?? T("2026-09-05T00:00:00.000Z"),
  lines: o.lines,
  revisions: o.revisions ?? [],
});
const line = (qty: number, extra: Record<string, unknown> = {}) => ({
  productId: "p1",
  qty,
  deliveredQty: 0,
  status: "PENDING",
  boxes: null,
  pieces: qty,
  unitsPerBox: 1,
  unitLabel: null,
  ...extra,
});

describe("D2 interposition (SA-902 MUST 4)", () => {
  it("an unrevised order: one sale at createdAt, a point window", () => {
    const r = interposeOrder(order({ lines: [line(8)] }), "p1", null, CUT);
    expect(r.events.map((e) => [e.at.toISOString(), Number(e.qty)])).toEqual([
      ["2026-09-05T00:00:00.000Z", -8],
    ]);
    expect(r.events[0].window).toEqual([
      T("2026-09-05T00:00:00.000Z"),
      T("2026-09-05T00:00:00.000Z"),
    ]);
    expect(r.approx).toEqual([]);
  });

  it("D2-2: revisions — the first snapshot at createdAt [createdAt, rev1], each Δ at its revision, the final Δ at updatedAt", () => {
    const o = order({
      createdAt: T("2026-09-01T00:00:00.000Z"),
      updatedAt: T("2026-09-10T00:00:00.000Z"),
      lines: [line(9)],
      revisions: [
        { createdAt: T("2026-09-02T00:00:00.000Z"), lineItems: [line(5)] },
        { createdAt: T("2026-09-04T00:00:00.000Z"), lineItems: [line(7)] },
      ],
    });
    const r = interposeOrder(o, "p1", null, CUT);
    expect(r.events.map((e) => [e.kind, e.at.toISOString(), Number(e.qty)])).toEqual([
      ["CREATE", "2026-09-01T00:00:00.000Z", -5],
      ["REVISION", "2026-09-04T00:00:00.000Z", -2],
      ["FINAL", "2026-09-10T00:00:00.000Z", -2],
    ]);
    expect(r.events.map((e) => e.window.map((d) => d.toISOString().slice(5, 10)))).toEqual([
      ["09-01", "09-02"],
      ["09-02", "09-04"],
      ["09-04", "09-10"],
    ]);
  });

  it("D2-3: a cancelled order credits the undelivered pieces at updatedAt, never dropped", () => {
    const o = order({
      status: "CANCELLED",
      updatedAt: T("2026-09-08T00:00:00.000Z"),
      lines: [line(10, { status: "CANCELLED", deliveredQty: 3, pieces: 10 })],
    });
    const r = interposeOrder(o, "p1", null, CUT);
    expect(r.events.map((e) => [e.kind, Number(e.qty)])).toEqual([
      ["CREATE", -10],
      ["CANCEL", 7],
    ]);
    expect(r.events[1].window).toEqual([
      T("2026-09-05T00:00:00.000Z"),
      T("2026-09-08T00:00:00.000Z"),
    ]);
  });

  it("D2-5: quantities in pieces through the order path's conversion; a line that needs the live pack is APPROX", () => {
    const split = interposeOrder(
      order({ lines: [line(27, { boxes: 2, pieces: 3, unitsPerBox: 12 })] }),
      "p1",
      12,
      CUT,
    );
    expect(Number(split.events[0].qty)).toBe(-27);
    expect(split.approx).toEqual([]);
    const boxUnaware = interposeOrder(
      order({ lines: [line(2, { boxes: null, pieces: null, unitsPerBox: null })] }),
      "p1",
      12,
      CUT,
    );
    expect(Number(boxUnaware.events[0].qty)).toBe(-24);
    expect(boxUnaware.approx).toEqual([expect.stringMatching(/live pack/)]);
  });

  it("the interposition stops at the cutover: an event at or after it is the ledger's; a window across it clamps and is APPROX", () => {
    const after = interposeOrder(
      order({
        createdAt: T("2026-09-25T00:00:00.000Z"),
        updatedAt: T("2026-09-25T00:00:00.000Z"),
        lines: [line(4)],
      }),
      "p1",
      null,
      CUT,
    );
    expect(after.events).toEqual([]);
    const crossing = interposeOrder(
      order({
        status: "CANCELLED",
        updatedAt: T("2026-09-30T00:00:00.000Z"),
        lines: [line(4, { status: "CANCELLED" })],
      }),
      "p1",
      null,
      CUT,
    );
    const credit = crossing.events.find((e) => e.kind === "CANCEL")!;
    expect(credit.at.getTime()).toBe(CUT.getTime() - 1);
    expect(credit.window[1].getTime()).toBe(CUT.getTime() - 1);
    expect(crossing.approx).toEqual([expect.stringMatching(/cutover/)]);
  });

  it("lines of other products are ignored", () => {
    const r = interposeOrder(order({ lines: [line(3, { productId: "p2" })] }), "p1", null, CUT);
    expect(r.events).toEqual([]);
  });
});

describe("D2 reconstruction (SA-902 MUSTs 3 and 5)", () => {
  it("D2-1, the hand pin: buy 10@1, a legacy sale of 8, buy 10@3 → 2.6667 (the live, sales-blind fold says 2.0)", () => {
    const ledger = [
      buy(10, 1, "2026-09-01T00:00:00.000Z"),
      buy(10, 3, "2026-09-10T00:00:00.000Z"),
      anchor(-8),
    ];
    const ev = interposeOrder(order({ lines: [line(8)] }), "p1", null, CUT).events; // the sale on 09-05
    const r = reconstruct({ ledger, events: ev, approx: [] });
    expect(Number(r.xC)).toBeCloseTo(2.6667, 4);
    expect(Number(r.xNow)).toBeCloseTo(2.6667, 4);
    expect(r.confidence).toBe("EXACT");
    expect(Number(r.residual)).toBe(0);
    expect(Number(foldLedger(ledger, { isStandard: false, averageCost: null }).avg)).toBe(2);
  });

  it("X_now folds the post-cutover rows after the pin at X_c", () => {
    const ledger = [
      buy(10, 1, "2026-09-01T00:00:00.000Z"),
      buy(10, 3, "2026-09-10T00:00:00.000Z"),
      anchor(-8),
      buy(12, 5, "2026-10-01T00:00:00.000Z"),
    ];
    const ev = interposeOrder(order({ lines: [line(8)] }), "p1", null, CUT).events;
    const r = reconstruct({ ledger, events: ev, approx: [] });
    // The pin is X_c at 4 dp (2.6667), as the live fold applies it: (12 × 2.6667 + 12 × 5) / 24 = 3.83335 → 3.8334.
    expect(Number(r.xC)).toBeCloseTo(2.6667, 4);
    expect(Number(r.xNow)).toBe(3.8334);
  });

  it("R-D2c: the residual (D1 qty − Σ interposed) is folded at the cutover; nonzero is APPROX and the stock at the cutover still equals the ledger's", () => {
    const ledger = [
      buy(10, 1, "2026-09-01T00:00:00.000Z"),
      buy(10, 3, "2026-09-10T00:00:00.000Z"),
      anchor(-9),
    ];
    const ev = interposeOrder(order({ lines: [line(8)] }), "p1", null, CUT).events;
    const r = reconstruct({ ledger, events: ev, approx: [] });
    expect(Number(r.residual)).toBe(-1);
    expect(r.confidence).toBe("APPROX");
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/residual/)]));
    expect(Number(r.stockAtCutover)).toBe(11); // 20 − 8 − 1, the ledger's 20 − 9
  });

  it("D2-4: a costful row inside any window (boundaries inclusive) is APPROX, naming the row", () => {
    const o = order({
      createdAt: T("2026-09-01T00:00:00.000Z"),
      updatedAt: T("2026-09-06T00:00:00.000Z"),
      lines: [line(8)],
      revisions: [{ createdAt: T("2026-09-03T00:00:00.000Z"), lineItems: [line(8)] }],
    });
    const ev = interposeOrder(o, "p1", null, CUT).events;
    const onBoundary = buy(10, 3, "2026-09-03T00:00:00.000Z");
    const ledger = [buy(10, 1, "2026-08-01T00:00:00.000Z"), onBoundary, anchor(-8)];
    const r = reconstruct({ ledger, events: ev, approx: [] });
    expect(r.confidence).toBe("APPROX");
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringContaining(onBoundary.id)]));
    // a costful row strictly outside every window keeps it EXACT
    const outside = reconstruct({
      ledger: [
        buy(10, 1, "2026-08-01T00:00:00.000Z"),
        buy(10, 3, "2026-09-07T00:00:00.000Z"),
        anchor(-8),
      ],
      events: ev,
      approx: [],
    });
    expect(outside.confidence).toBe("EXACT");
  });

  it("parity (MUST 3): no interposed events → the residual IS the anchor row, and X_now equals the live replay's average", () => {
    const ledger = [
      buy(10, 1, "2026-09-01T00:00:00.000Z"),
      buy(10, 3, "2026-09-10T00:00:00.000Z"),
      anchor(-8),
      buy(4, 6, "2026-10-02T00:00:00.000Z"),
    ];
    const r = reconstruct({ ledger, events: [], approx: [] });
    const live = foldLedger(ledger, { isStandard: false, averageCost: null });
    expect(Number(r.xNow)).toBeCloseTo(Number(live.avg), 4);
    expect(Number(r.residual)).toBe(-8);
  });

  it("prior REPAIR and RECOMPUTE rows are not inputs to the reconstruction; a pre-cutover manual cost basis is", () => {
    const ledger = [
      buy(10, 1, "2026-09-01T00:00:00.000Z"),
      row(MovementType.COST_BASIS, 0, "2026-09-02T00:00:00.000Z", {
        unitCost: D(9),
        reference: "RECOMPUTE:X",
      }),
      row(MovementType.COST_BASIS, 0, "2026-09-24T00:00:00.000Z", {
        unitCost: D(9),
        reference: "B562:REPAIR:old",
      }),
      anchor(0.001 - 0.001), // a zero anchor (no drift) for this case
    ];
    const r = reconstruct({ ledger, events: [], approx: [] });
    expect(Number(r.xC)).toBe(1);
  });

  it("no costful history before the cutover → no X_c (nothing to repair)", () => {
    const r = reconstruct({
      ledger: [anchor(-3), buy(5, 2, "2026-10-01T00:00:00.000Z")],
      events: [],
      approx: [],
    });
    expect(r.xC).toBeNull();
  });
});
