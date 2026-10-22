import { counterMethodLine, counterTenderSplit } from "./counter-tender-split";
import type { ReturnSettlement } from "./return-settlement";

/**
 * B1262 / SA-838: the ONE split of a counter sale's PAID payments into what the customer TENDERED and the credit the
 * sale's OWN return made (a credit note applied back to its own invoice). The own-return credit is not new money: it is
 * the return settling the invoice, so it must not print as a tender nor count as Paid on the paper.
 */
const ORDER = ["CASH", "CARD", "CHECK", "OTHER", "ADVANCE", "STORE_CREDIT"] as const;
const pay = (method: string, amount: unknown, extra: Record<string, unknown> = {}) => ({
  method,
  amount,
  status: "PAID",
  ...extra,
});

/** a settlement as `returnSettlement` hands it over: the credit note it spoke for and what of it was applied here */
const settled = (creditNoteId: string, applied: number): ReturnSettlement => ({
  state: "SETTLED",
  creditNoteId,
  applied,
  refunded: 0,
  appliedElsewhere: 0,
  kept: 0,
});

describe("counterTenderSplit (SA-838, SA-838a)", () => {
  it("(a) on account $12.50, $6.25 returned, $6.25 cash: the own return credit is not a tender", () => {
    const r = counterTenderSplit(
      [pay("CASH", 6.25), pay("STORE_CREDIT", 6.25, { creditNoteId: "cn-1" })],
      [settled("cn-1", 6.25)],
      ORDER,
    );
    expect(r).toEqual({
      tenderPaid: 6.25,
      returnCredit: 6.25,
      methods: [{ method: "CASH", amount: 6.25 }],
    });
  });

  it("(b) a $5 advance and $7.50 cash with a refund paid outside: both are tenders, no return credit", () => {
    const r = counterTenderSplit([pay("ADVANCE", 5), pay("CASH", 7.5)], [], ORDER);
    expect(r).toEqual({
      tenderPaid: 12.5,
      returnCredit: 0,
      methods: [
        { method: "CASH", amount: 7.5 },
        { method: "ADVANCE", amount: 5 },
      ],
    });
  });

  it("(c) paid fully from an advance: ADVANCE is its own method, never folded into store credit", () => {
    const r = counterTenderSplit([pay("ADVANCE", 12.5)], [], ORDER);
    expect(r.tenderPaid).toBe(12.5);
    expect(r.methods).toEqual([{ method: "ADVANCE", amount: 12.5 }]);
  });

  it("(d) store credit from ANOTHER order's return stays a tender", () => {
    const r = counterTenderSplit(
      [pay("STORE_CREDIT", 4, { creditNoteId: "cn-other" })],
      [settled("cn-own", 0)],
      ORDER,
    );
    expect(r).toEqual({
      tenderPaid: 4,
      returnCredit: 0,
      methods: [{ method: "STORE_CREDIT", amount: 4 }],
    });
  });

  it("a credit note payment with no note id is a tender (never hide money)", () => {
    const r = counterTenderSplit(
      [pay("STORE_CREDIT", 3, { creditNoteId: null })],
      [settled("cn-1", 0)],
      ORDER,
    );
    expect(r.tenderPaid).toBe(3);
    expect(r.returnCredit).toBe(0);
  });

  it("two payments on the same own note add to the return credit; a second own note too", () => {
    const r = counterTenderSplit(
      [
        pay("STORE_CREDIT", 1.1, { creditNoteId: "cn-1" }),
        pay("STORE_CREDIT", 2.2, { creditNoteId: "cn-1" }),
        pay("STORE_CREDIT", 0.35, { creditNoteId: "cn-2" }),
      ],
      [settled("cn-1", 3.3), settled("cn-2", 0.35)],
      ORDER,
    );
    expect(r.returnCredit).toBe(3.65);
    expect(r.tenderPaid).toBe(0);
    expect(r.methods).toEqual([]);
  });

  it("sums in cents: 0.1 + 0.2 tenders read 0.3, and per-method amounts are rounded", () => {
    const r = counterTenderSplit(
      [pay("CASH", 0.1), pay("CASH", 0.2), pay("CARD", "0.30")],
      [],
      ORDER,
    );
    expect(r.tenderPaid).toBe(0.6);
    expect(r.methods).toEqual([
      { method: "CASH", amount: 0.3 },
      { method: "CARD", amount: 0.3 },
    ]);
  });

  it("only PAID payments count: DRAFT, PENDING and VOID rows are in no figure", () => {
    const r = counterTenderSplit(
      [
        pay("CASH", 5),
        { method: "CASH", amount: 9, status: "VOID" },
        { method: "CARD", amount: 8, status: "DRAFT" },
        { method: "CHECK", amount: 7, status: "PENDING" },
        { method: "STORE_CREDIT", amount: 6, status: "VOID", creditNoteId: "cn-1" },
      ],
      [settled("cn-1", 0)],
      ORDER,
    );
    expect(r).toEqual({ tenderPaid: 5, returnCredit: 0, methods: [{ method: "CASH", amount: 5 }] });
  });

  it("methods follow the caller's order, not the payments' order; with none given, first appearance", () => {
    const rows = [pay("CARD", 2), pay("CASH", 1)];
    expect(counterTenderSplit(rows, [], ORDER).methods.map((m) => m.method)).toEqual([
      "CASH",
      "CARD",
    ]);
    expect(counterTenderSplit(rows, []).methods.map((m) => m.method)).toEqual(["CARD", "CASH"]);
  });

  it("tenderPaid + returnCredit is the sum of every PAID payment", () => {
    const rows = [
      pay("CASH", 6.25),
      pay("STORE_CREDIT", 6.25, { creditNoteId: "cn-1" }),
      pay("ADVANCE", 1.01),
    ];
    const r = counterTenderSplit(rows, [settled("cn-1", 6.25)], ORDER);
    expect(r.tenderPaid + r.returnCredit).toBeCloseTo(13.51, 10);
  });

  it("no payments: zero everywhere and no methods", () => {
    expect(counterTenderSplit([], [], ORDER)).toEqual({
      tenderPaid: 0,
      returnCredit: 0,
      methods: [],
    });
  });
});

describe("counterMethodLine (the ONE Payment method line, email and reprint; SA-838a)", () => {
  it("two or more tenders carry their amounts", () => {
    expect(
      counterMethodLine([
        { method: "ADVANCE", amount: 5 },
        { method: "CASH", amount: 7.5 },
      ]),
    ).toBe("Advance $5.00 + Cash $7.50");
  });

  it("a single tender carries its amount, whether or not it is the whole sale", () => {
    expect(counterMethodLine([{ method: "CASH", amount: 6.25 }])).toBe("Cash $6.25");
    expect(counterMethodLine([{ method: "ADVANCE", amount: 12.5 }])).toBe("Advance $12.50");
    expect(counterMethodLine([{ method: "CARD", amount: 0.1 + 0.2 }])).toBe("Card $0.30");
  });

  it("no tenders is an empty line", () => {
    expect(counterMethodLine([])).toBe("");
  });
});
