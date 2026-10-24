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
  ledger: o.ledger,
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

  it("D2-2: revisions — the first snapshot at createdAt, each Δ at its revision, the final Δ at updatedAt", () => {
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
      // SA-921: a touched non-counter order may have moved stock at an unrecorded time: EVERY event spans [createdAt, updatedAt]
      ["09-01", "09-10"],
      ["09-01", "09-10"],
      ["09-01", "09-10"],
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
    expect(crossing.approx).toEqual(
      expect.arrayContaining([expect.stringMatching(/CANCEL window crosses the cutover/)]),
    );
  });

  // SA-911 (a DRAFT took its stock at promotion; that time is not stored) — Opus #3696 MUST 2's example.
  it("SA-911/921: a staff order created 09-01, promoted by 09-05, with 10 @ $3 bought 09-03, is APPROX (head: a point, EXACT)", () => {
    const o = order({
      createdAt: T("2026-09-01T00:00:00.000Z"),
      updatedAt: T("2026-09-05T00:00:00.000Z"),
      lines: [line(8)],
    });
    const ev = interposeOrder(o, "p1", null, CUT).events;
    expect(ev[0].window).toEqual([T("2026-09-01T00:00:00.000Z"), T("2026-09-05T00:00:00.000Z")]);
    const r = reconstruct({
      ledger: [
        buy(10, 1, "2026-08-31T00:00:00.000Z"),
        buy(10, 3, "2026-09-03T00:00:00.000Z"),
        anchor(-8),
      ],
      events: ev,
      approx: [],
    });
    expect(r.confidence).toBe("APPROX");
  });

  it("SA-923 M1: a legacy counter sale touched after creation (a void → reopen) is APPROX — no counter-sale exemption", () => {
    const o = order({
      createdAt: T("2026-09-01T00:00:00.000Z"),
      updatedAt: T("2026-09-05T00:00:00.000Z"), // the reopen bumped it
      lines: [line(8)],
    });
    const ev = interposeOrder(o, "p1", null, CUT).events;
    expect(ev[0].window).toEqual([T("2026-09-01T00:00:00.000Z"), T("2026-09-05T00:00:00.000Z")]);
    const r = reconstruct({
      ledger: [
        buy(10, 1, "2026-08-31T00:00:00.000Z"),
        buy(10, 3, "2026-09-03T00:00:00.000Z"),
        anchor(-8),
      ],
      events: ev,
      approx: [],
    });
    expect(r.confidence).toBe("APPROX");
  });

  it("SA-911: a pre-cutover draft promoted AFTER the cutover (a PROMOTE ledger row) is not interposed at all", () => {
    const o = order({
      createdAt: T("2026-09-05T00:00:00.000Z"),
      updatedAt: T("2026-09-26T00:00:00.000Z"),
      lines: [line(8)],
      ledger: { rows: 1, qty: D(-8), promoted: true },
    });
    expect(interposeOrder(o, "p1", null, CUT)).toEqual({ events: [], approx: [] });
  });

  it("SA-911 skip: a post-cutover event of an order WITH ORDER:<id> rows is dropped (no clamp, no false APPROX)", () => {
    const o = order({
      createdAt: T("2026-09-05T00:00:00.000Z"),
      updatedAt: T("2026-09-28T00:00:00.000Z"),
      lines: [line(10)],
      revisions: [{ createdAt: T("2026-09-06T00:00:00.000Z"), lineItems: [line(8)] }],
      ledger: { rows: 1, qty: D(-2), promoted: false }, // the post-cutover EDIT 8 → 10, ledgered
    });
    const r = interposeOrder(o, "p1", null, CUT);
    expect(r.events.map((e) => [e.kind, Number(e.qty)])).toEqual([["CREATE", -8]]);
    expect(r.approx).toEqual([]);
  });

  it("SA-911: the same event on an order with NO ledger rows is clamped and APPROX (a legacy change)", () => {
    const o = order({
      createdAt: T("2026-09-05T00:00:00.000Z"),
      updatedAt: T("2026-09-28T00:00:00.000Z"),
      lines: [line(10)],
      revisions: [{ createdAt: T("2026-09-06T00:00:00.000Z"), lineItems: [line(8)] }],
    });
    const r = interposeOrder(o, "p1", null, CUT);
    expect(r.events.map((e) => [e.kind, Number(e.qty)])).toEqual([
      ["CREATE", -8],
      ["FINAL", -2],
    ]);
    expect(r.events[1].at.getTime()).toBe(CUT.getTime() - 1);
    expect(r.approx).toEqual(
      expect.arrayContaining([expect.stringMatching(/FINAL window crosses the cutover/)]),
    );
  });

  it("SA-923 M2: a diff on an order with NO snapshot dated at or after the cutover is never absorbed: N pieces unplaced", () => {
    const o = order({
      createdAt: T("2026-09-05T00:00:00.000Z"),
      updatedAt: T("2026-09-05T00:00:00.000Z"),
      lines: [line(10)],
      ledger: { rows: 1, qty: D(-3), promoted: false }, // the ledger says 3 moved after the cutover, yet nothing embeds it
    });
    const r = interposeOrder(o, "p1", null, CUT);
    expect(r.events.map((e) => [e.kind, Number(e.qty)])).toEqual([["CREATE", -10]]); // head e2b2dbd42: absorbed to −7
    expect(r.approx).toEqual([expect.stringMatching(/order o1: 3 pieces unplaced/)]);
  });

  it("SA-923 sign guard: a back-out that would flip an event's sign (a sale becoming a credit) is named, not absorbed", () => {
    const o = order({
      createdAt: T("2026-09-05T00:00:00.000Z"),
      updatedAt: T("2026-09-28T00:00:00.000Z"),
      lines: [line(2)],
      revisions: [{ createdAt: T("2026-09-28T00:00:00.000Z"), lineItems: [line(2)] }],
      ledger: { rows: 1, qty: D(-8), promoted: false }, // the ledger claims 8 sold after the cutover on a 2-piece order
    });
    const r = interposeOrder(o, "p1", null, CUT);
    expect(r.events.map((e) => [e.kind, Number(e.qty)])).toEqual([["CREATE", -2]]); // head e2b2dbd42: +6 (a credit)
    expect(r.approx).toEqual([expect.stringMatching(/order o1: 8 pieces unplaced/)]);
  });

  it("SA-911 SHOULD (kept): a post-cutover snapshot's part is backed out of the CREATE; with nothing embedding it, the pieces are named", () => {
    const o = order({
      createdAt: T("2026-09-05T00:00:00.000Z"),
      updatedAt: T("2026-09-28T00:00:00.000Z"),
      lines: [line(10)],
      revisions: [{ createdAt: T("2026-09-28T00:00:00.000Z"), lineItems: [line(10)] }],
      ledger: { rows: 1, qty: D(-4), promoted: false },
    });
    // the only snapshot is post-cutover, so the CREATE (window [09-05, 09-28]) is the one pre-cutover event: −10 → −6
    const r = interposeOrder(o, "p1", null, CUT);
    expect(r.events.map((e) => [e.kind, Number(e.qty)])).toEqual([["CREATE", -6]]);
    const none = interposeOrder(
      order({
        createdAt: T("2026-09-05T00:00:00.000Z"),
        updatedAt: T("2026-09-28T00:00:00.000Z"),
        lines: [line(10)],
        revisions: [{ createdAt: T("2026-09-06T00:00:00.000Z"), lineItems: [] }],
        ledger: { rows: 1, qty: D(-4), promoted: false },
      }),
      "p1",
      null,
      CUT,
    );
    // no pre-cutover event and no snapshot at or after the cutover (SA-923 M2): an unrevised legacy edit, named only
    expect(none.events).toEqual([]);
    expect(none.approx).toEqual([expect.stringMatching(/order o1: -6 pieces unplaced/)]);
  });

  // SA-921 MUST 2: an order whose stock may have moved at an UNRECORDED time (promotion, demote/re-promote, cancel → reopen).
  const reasonUnrecorded =
    /order o1: its stock may have moved any time from created to last updated/;
  it("SA-921: the reviewer's example (10@1; draft d1 for 8; 10@3 d3; promoted d5) is APPROX with the order named", () => {
    const o = order({
      createdAt: T("2026-09-01T00:00:00.000Z"),
      updatedAt: T("2026-09-05T00:00:00.000Z"),
      lines: [line(8)],
    });
    const r = reconstruct({
      ledger: [
        buy(10, 1, "2026-08-31T00:00:00.000Z"),
        buy(10, 3, "2026-09-03T00:00:00.000Z"),
        anchor(-8),
      ],
      events: interposeOrder(o, "p1", null, CUT).events,
      approx: [],
    });
    expect(r.confidence).toBe("APPROX");
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(reasonUnrecorded)]));
  });

  it("SA-921: a demote/re-promote — a product that arrived by a revision, with a purchase BEFORE that revision — is APPROX (before SA-921: its narrow REVISION window, EXACT)", () => {
    const o = order({
      createdAt: T("2026-09-01T00:00:00.000Z"),
      updatedAt: T("2026-09-08T00:00:00.000Z"),
      lines: [line(6)],
      revisions: [
        { createdAt: T("2026-09-02T00:00:00.000Z"), lineItems: [] },
        { createdAt: T("2026-09-06T00:00:00.000Z"), lineItems: [line(6)] },
      ],
    });
    const ev = interposeOrder(o, "p1", null, CUT).events;
    expect(ev.map((e) => e.kind)).toEqual(["REVISION"]);
    expect(ev[0].window).toEqual([T("2026-09-01T00:00:00.000Z"), T("2026-09-08T00:00:00.000Z")]);
    const r = reconstruct({
      ledger: [
        buy(10, 1, "2026-08-31T00:00:00.000Z"),
        buy(10, 3, "2026-09-03T00:00:00.000Z"),
        anchor(-6),
      ],
      events: ev,
      approx: [],
    });
    expect(r.confidence).toBe("APPROX");
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(reasonUnrecorded)]));
  });

  it("SA-921: a cancel → reopen with a purchase in between is APPROX", () => {
    const o = order({
      status: "PENDING", // reopened: nothing in the row says when the stock went back and out again
      createdAt: T("2026-09-01T00:00:00.000Z"),
      updatedAt: T("2026-09-09T00:00:00.000Z"),
      lines: [line(5)],
      revisions: [{ createdAt: T("2026-09-02T00:00:00.000Z"), lineItems: [line(5)] }],
    });
    const r = reconstruct({
      ledger: [
        buy(10, 1, "2026-08-31T00:00:00.000Z"),
        buy(10, 3, "2026-09-07T00:00:00.000Z"),
        anchor(-5),
      ],
      events: interposeOrder(o, "p1", null, CUT).events,
      approx: [],
    });
    expect(r.confidence).toBe("APPROX");
  });

  it("SA-921: an order never updated after creation (createdAt == updatedAt) keeps a point and is EXACT", () => {
    const o = order({
      createdAt: T("2026-09-02T00:00:00.000Z"),
      updatedAt: T("2026-09-02T00:00:00.000Z"),
      lines: [line(8)],
    });
    const ev = interposeOrder(o, "p1", null, CUT).events;
    expect(ev[0].window).toEqual([T("2026-09-02T00:00:00.000Z"), T("2026-09-02T00:00:00.000Z")]);
    const r = reconstruct({
      ledger: [
        buy(10, 1, "2026-08-31T00:00:00.000Z"),
        buy(10, 3, "2026-09-03T00:00:00.000Z"),
        anchor(-8),
      ],
      events: ev,
      approx: [],
    });
    expect(r.confidence).toBe("EXACT");
  });

  // SA-921 Q5 (SA-923: EXACT asserted with a bill inside the order's raw window): bills 10@1 09-01 and 10@3 09-03; an order
  // created 09-08 for 10, edited after the cutover to 15 (ORDER −5, its 09-28 snapshot used for the CREATE); a bill of
  // 10@5 on 09-26, inside [createdAt, updatedAt] but after the cutover. Pre-cutover: 20@2 − 10 → 2.0000.
  const q5 = (createdAt: string) =>
    order({
      createdAt: T(createdAt),
      updatedAt: T("2026-09-28T00:00:00.000Z"),
      lines: [line(15)],
      revisions: [{ createdAt: T("2026-09-28T00:00:00.000Z"), lineItems: [line(15)] }],
      ledger: { rows: 1, qty: D(-5), promoted: false },
    });
  const q5Ledger = () => [
    buy(10, 1, "2026-09-01T00:00:00.000Z"),
    buy(10, 3, "2026-09-03T00:00:00.000Z"),
    anchor(-10),
    buy(10, 5, "2026-09-26T00:00:00.000Z"),
  ];
  it("SA-921 Q5: backed out to the pre-edit 10 → 2.0000 EXACT, residual 0, with a post-cutover bill inside the raw window", () => {
    const i = interposeOrder(q5("2026-09-08T00:00:00.000Z"), "p1", null, CUT);
    expect(i.events.map((e) => [e.kind, Number(e.qty)])).toEqual([["CREATE", -10]]);
    expect(i.approx).toEqual([]);
    const r = reconstruct({ ledger: q5Ledger(), events: i.events, approx: i.approx });
    expect(Number(r.xC)).toBe(2);
    expect(Number(r.residual)).toBe(0);
    expect(r.confidence).toBe("EXACT");
  });

  it("SA-921 Q5 + MUST 2: the same order created 09-02, before the 09-03 bill, is APPROX (the bill is in its window; placed at 09-02 → 3.0000)", () => {
    const i = interposeOrder(q5("2026-09-02T00:00:00.000Z"), "p1", null, CUT);
    expect(i.events.map((e) => [e.kind, Number(e.qty)])).toEqual([["CREATE", -10]]);
    const r = reconstruct({ ledger: q5Ledger(), events: i.events, approx: i.approx });
    expect(Number(r.xC)).toBe(3);
    expect(r.confidence).toBe("APPROX");
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(reasonUnrecorded)]));
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
