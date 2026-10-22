import { counterTenderSplit } from "./counter-tender-split";
import { returnSettlement, type SettlementReturn } from "./return-settlement";
import { roundMoney } from "./pricing";

/**
 * SA-838a: ONE helper says what a sale's own return did on the paper. The invariant every fixture below (and the
 * deterministic randomised cases) must hold, in cents:
 *   Balance due = Total - Paid (tenders) - Returned (own-return credit APPLIED to this order's invoices).
 * A refunded or kept credit is shown, never subtracted. The state (pending / settled) only gates the info lines.
 */
const ORDER = ["ADVANCE", "CASH", "CARD", "CHECK", "OTHER", "STORE_CREDIT"] as const;
const THIS = "ord-1";

const pay = (method: string, amount: number, creditNoteId?: string) => ({
  method,
  amount,
  status: "PAID",
  ...(creditNoteId ? { creditNoteId } : {}),
});

const standard = (over: Partial<SettlementReturn> = {}): SettlementReturn => ({
  id: "ret-1",
  kind: "STANDARD",
  orderId: THIS,
  status: "PROCESSED",
  amount: 2.5,
  creditNoteId: null,
  refundMethod: null,
  refundedAt: null,
  ...over,
});

interface Fixture {
  name: string;
  total: number;
  payments: Array<ReturnType<typeof pay>>;
  returns: SettlementReturn[];
  /** what the receipt must show */
  expect: {
    paid: number;
    applied: number;
    refunded: number;
    kept: number;
    pending: boolean;
    balance: number;
  };
}

const FIXTURES: Fixture[] = [
  {
    name: "(1a) Total 12.50, Cash 5.00, own return 2.50 refunded outside",
    total: 12.5,
    payments: [pay("CASH", 5)],
    returns: [
      standard({
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundedAt: "2026-10-22T10:00:00Z",
      }),
    ],
    expect: { paid: 5, applied: 0, refunded: 2.5, kept: 0, pending: false, balance: 7.5 },
  },
  {
    name: "(1b) the credit is kept on the account (issued, not applied here)",
    total: 12.5,
    payments: [pay("CASH", 5)],
    returns: [standard({ creditNoteId: "cn-1", creditNoteStatus: "ISSUED" })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 2.5, pending: false, balance: 7.5 },
  },
  {
    name: "(1c) the credit is applied to this sale's invoice",
    total: 12.5,
    payments: [pay("CASH", 5), pay("STORE_CREDIT", 2.5, "cn-1")],
    returns: [standard({ creditNoteId: "cn-1", creditNoteStatus: "APPLIED" })],
    expect: { paid: 5, applied: 2.5, refunded: 0, kept: 0, pending: false, balance: 5 },
  },
  {
    name: "(2) the return is still pending: nothing is subtracted, nothing is shown but the note",
    total: 12.5,
    payments: [pay("CASH", 5)],
    returns: [standard({ status: "PENDING", amount: 2.5 })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 0, pending: true, balance: 7.5 },
  },
  {
    name: "(a) on account 12.50, 6.25 returned and applied, 6.25 cash",
    total: 12.5,
    payments: [pay("CASH", 6.25), pay("STORE_CREDIT", 6.25, "cn-1")],
    returns: [standard({ amount: 6.25, creditNoteId: "cn-1", creditNoteStatus: "APPLIED" })],
    expect: { paid: 6.25, applied: 6.25, refunded: 0, kept: 0, pending: false, balance: 0 },
  },
  {
    name: "(b) 5.00 advance + 7.50 cash, 2.50 refunded outside",
    total: 12.5,
    payments: [pay("ADVANCE", 5), pay("CASH", 7.5)],
    returns: [
      standard({
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundedAt: "2026-10-22T10:00:00Z",
      }),
    ],
    expect: { paid: 12.5, applied: 0, refunded: 2.5, kept: 0, pending: false, balance: 0 },
  },
  {
    name: "(c) paid fully from an advance, 3.00 returned and kept",
    total: 12.5,
    payments: [pay("ADVANCE", 12.5)],
    returns: [standard({ amount: 3, creditNoteId: "cn-1", creditNoteStatus: "ISSUED" })],
    expect: { paid: 12.5, applied: 0, refunded: 0, kept: 3, pending: false, balance: 0 },
  },
  {
    name: "a credit partly applied here: the rest is kept",
    total: 12.5,
    payments: [pay("CASH", 5), pay("STORE_CREDIT", 1, "cn-1")],
    returns: [standard({ creditNoteId: "cn-1", creditNoteStatus: "APPLIED" })],
    expect: { paid: 5, applied: 1, refunded: 0, kept: 1.5, pending: false, balance: 6.5 },
  },
  {
    name: "(d) store credit from ANOTHER order's return stays a tender",
    total: 12.5,
    payments: [pay("STORE_CREDIT", 12.5, "cn-other")],
    returns: [],
    expect: { paid: 12.5, applied: 0, refunded: 0, kept: 0, pending: false, balance: 0 },
  },
  {
    name: "a rejected return is dead: nothing printed, nothing subtracted",
    total: 12.5,
    payments: [pay("CASH", 5)],
    returns: [standard({ status: "REJECTED" })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 0, pending: false, balance: 7.5 },
  },
  {
    name: "an issued credit note that was voided is not settled: it is neither kept nor applied",
    total: 12.5,
    payments: [pay("CASH", 5)],
    returns: [standard({ creditNoteId: "cn-1", creditNoteStatus: "VOID" })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 0, pending: true, balance: 7.5 },
  },
  {
    name: "an INLINE return carried here but sold on another order is not this order's",
    total: 12.5,
    payments: [pay("CASH", 12.5)],
    returns: [
      {
        id: "ret-9",
        kind: "INLINE",
        orderId: THIS,
        status: "PROCESSED",
        creditNoteId: null,
        refundMethod: "EXTERNAL_REFUND",
        refundedAt: "2026-10-22T10:00:00Z",
        items: [{ sourceOrderId: "ord-other", subtotal: 5, taxAmount: 0, categoryTax: 0 }],
      },
    ],
    expect: { paid: 12.5, applied: 0, refunded: 0, kept: 0, pending: false, balance: 0 },
  },
];

/** The reading every surface takes: ONE settlement per own return, ONE split. Never re-derived anywhere else. */
function read(f: Pick<Fixture, "total" | "payments" | "returns">) {
  // the caller's provenance read: the payments whose credit note a live return of THIS order made
  const ownCn = new Set(
    f.returns
      .filter((r) => r.creditNoteId && r.status !== "REJECTED" && r.status !== "CANCELLED")
      .map((r) => r.creditNoteId as string),
  );
  const ownCredit = f.payments.filter((p) => "creditNoteId" in p && ownCn.has(p.creditNoteId!));
  const settlements = f.returns.map((r) => returnSettlement(r, ownCredit, THIS));
  const split = counterTenderSplit(f.payments, settlements, ORDER);
  const sum = (pick: (s: (typeof settlements)[number]) => number) =>
    roundMoney(settlements.reduce((t, s) => t + pick(s), 0));
  return {
    settlements,
    split,
    applied: sum((s) => s.applied),
    refunded: sum((s) => s.refunded),
    kept: sum((s) => s.kept),
    pending: settlements.some((s) => s.state === "PENDING"),
    // the stored balance: what the invoices still owe after EVERY paid payment, credit included
    balance: Math.max(
      0,
      roundMoney(f.total - roundMoney(f.payments.reduce((t, p) => t + p.amount, 0))),
    ),
  };
}

describe("returnSettlement (SA-838a): the pinned fixtures", () => {
  it.each(FIXTURES)("$name", (f) => {
    const r = read(f);
    expect(r.split.tenderPaid).toBe(f.expect.paid);
    expect(r.applied).toBe(f.expect.applied);
    expect(r.refunded).toBe(f.expect.refunded);
    expect(r.kept).toBe(f.expect.kept);
    expect(r.pending).toBe(f.expect.pending);
    expect(r.balance).toBe(f.expect.balance);
  });

  it("the state: a credit note issued and not VOID, or a completed external refund, is SETTLED", () => {
    const state = (over: Partial<SettlementReturn>) =>
      returnSettlement(standard(over), [], THIS).state;
    expect(state({ creditNoteId: "cn-1", creditNoteStatus: "ISSUED" })).toBe("SETTLED");
    expect(state({ creditNoteId: "cn-1", creditNoteStatus: "APPLIED" })).toBe("SETTLED");
    // a note whose status the caller could not read is still a minted note (never hide a settled credit)
    expect(state({ creditNoteId: "cn-1" })).toBe("SETTLED");
    expect(state({ refundMethod: "EXTERNAL_REFUND", refundedAt: "2026-10-22T10:00:00Z" })).toBe(
      "SETTLED",
    );
    expect(state({ creditNoteId: "cn-1", creditNoteStatus: "VOID" })).toBe("PENDING");
  });

  it("PENDING, APPROVED and IN_TRANSIT are not settled; a refund chosen but not recorded is not complete", () => {
    for (const status of ["PENDING", "APPROVED", "IN_TRANSIT", "RECEIVED"]) {
      expect(returnSettlement(standard({ status }), [], THIS).state).toBe("PENDING");
    }
    expect(
      returnSettlement(
        standard({ status: "APPROVED", refundMethod: "EXTERNAL_REFUND", refundedAt: null }),
        [],
        THIS,
      ),
    ).toMatchObject({ state: "PENDING", refunded: 0, kept: 0, applied: 0 });
  });

  it("REJECTED and CANCELLED are DEAD with every figure zero", () => {
    for (const status of ["REJECTED", "CANCELLED"]) {
      expect(
        returnSettlement(
          standard({ status, creditNoteId: "cn-1" }),
          [pay("CASH", 2.5, "cn-1")],
          THIS,
        ),
      ).toMatchObject({ state: "DEAD", applied: 0, refunded: 0, kept: 0 });
    }
  });

  it("only PAID payments of THIS return's credit note count as applied", () => {
    const s = returnSettlement(
      standard({ creditNoteId: "cn-1", creditNoteStatus: "APPLIED" }),
      [
        pay("STORE_CREDIT", 1, "cn-1"),
        { method: "STORE_CREDIT", amount: 9, status: "VOID", creditNoteId: "cn-1" },
        pay("STORE_CREDIT", 0.5, "cn-2"),
        pay("CASH", 4),
      ],
      THIS,
    );
    expect(s.applied).toBe(1);
    expect(s.kept).toBe(1.5);
  });

  it("an INLINE return is worth the priced items sold on this order (cents), not the carrier amount", () => {
    const inline: SettlementReturn = {
      id: "ret-2",
      kind: "INLINE",
      orderId: "ord-carrier",
      status: "PROCESSED",
      creditNoteId: "cn-2",
      creditNoteStatus: "ISSUED",
      amount: 99,
      items: [
        { sourceOrderId: THIS, subtotal: 5, taxAmount: 0.4, categoryTax: 0.1 },
        { sourceOrderId: "ord-other", subtotal: 50, taxAmount: 0, categoryTax: 0 },
      ],
    };
    expect(returnSettlement(inline, [], THIS)).toMatchObject({
      state: "SETTLED",
      applied: 0,
      kept: 5.5,
    });
  });

  it("the settlement echoes the credit note it spoke for, so the split can tell tender from return credit", () => {
    expect(
      returnSettlement(standard({ creditNoteId: "cn-1" }), [pay("STORE_CREDIT", 2.5, "cn-1")], THIS)
        .creditNoteId,
    ).toBe("cn-1");
    expect(returnSettlement(standard(), [], THIS).creditNoteId).toBeNull();
  });
});

describe("the invariant: Balance due = Total - Paid (tenders) - Returned (applied), in cents", () => {
  const check = (f: Pick<Fixture, "total" | "payments" | "returns">) => {
    const r = read(f);
    const cents = (n: number) => Math.round(n * 100);
    // overpaid sales clamp at 0 and are outside the identity
    const paidAll = f.payments.reduce((t, p) => t + cents(p.amount), 0);
    if (paidAll > cents(f.total)) return;
    expect(cents(r.balance)).toBe(cents(f.total) - cents(r.split.tenderPaid) - cents(r.applied));
    // tenders and the applied credit add up to every paid payment
    expect(cents(r.split.tenderPaid) + cents(r.split.returnCredit)).toBe(paidAll);
    expect(cents(r.split.returnCredit)).toBe(cents(r.applied));
  };

  it("holds for every pinned fixture", () => {
    for (const f of FIXTURES) check(f);
  });

  it("a refunded or kept credit never changes the balance: the same sale reads one balance in every state", () => {
    const base = { total: 12.5, payments: [pay("CASH", 5)] };
    const states: SettlementReturn[] = [
      standard({ status: "PENDING" }),
      standard({
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundedAt: "2026-10-22T10:00:00Z",
      }),
      standard({ creditNoteId: "cn-1", creditNoteStatus: "ISSUED" }),
      standard({ status: "REJECTED" }),
    ];
    const balances = states.map((s) => read({ ...base, returns: [s] }).balance);
    expect(new Set(balances)).toEqual(new Set([7.5]));
  });

  it("holds for 600 deterministic randomised sales (seeded, cents)", () => {
    let seed = 20261022;
    const next = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const dollars = (cents: number) => roundMoney(cents / 100);
    for (let i = 0; i < 600; i++) {
      const totalC = 100 + next(99_900);
      const worthC = 1 + next(totalC);
      // the credit applied here can be none, part or all of the return
      const kind = next(5);
      const appliedC = kind === 2 ? worthC : kind === 3 ? next(worthC + 1) : 0;
      const tenderRoom = totalC - appliedC;
      const tenderC = next(tenderRoom + 1);
      const advC = next(tenderC + 1);
      const payments = [
        ...(advC > 0 ? [pay("ADVANCE", dollars(advC))] : []),
        ...(tenderC - advC > 0 ? [pay("CASH", dollars(tenderC - advC))] : []),
        ...(appliedC > 0 ? [pay("STORE_CREDIT", dollars(appliedC), "cn-1")] : []),
      ];
      const ret: SettlementReturn =
        kind === 0
          ? standard({ amount: dollars(worthC), status: "PENDING" })
          : kind === 1
            ? standard({
                amount: dollars(worthC),
                status: "REFUNDED",
                refundMethod: "EXTERNAL_REFUND",
                refundedAt: "2026-10-22T10:00:00Z",
              })
            : standard({
                amount: dollars(worthC),
                creditNoteId: "cn-1",
                creditNoteStatus: kind === 4 ? "ISSUED" : "APPLIED",
              });
      const f = { total: dollars(totalC), payments, returns: [ret] };
      check(f);
      const r = read(f);
      // a settled credit is shown once: applied + kept (credit) or refunded, never more than the return is worth
      expect(roundMoney(r.applied + r.refunded + r.kept)).toBeLessThanOrEqual(
        Math.max(dollars(worthC), r.applied),
      );
      expect(r.kept).toBeGreaterThanOrEqual(0);
      if (kind === 1) expect(r.refunded).toBe(dollars(worthC));
      if (kind === 0) expect([r.applied, r.refunded, r.kept, r.pending]).toEqual([0, 0, 0, true]);
    }
  });
});
