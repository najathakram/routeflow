import { counterTenderSplit } from "./counter-tender-split";
import { returnSettlement, settlementTotals, type SettlementReturn } from "./return-settlement";
import { roundMoney } from "./pricing";

/**
 * SA-838a: ONE helper says what a sale's own return did on the paper. The invariant every fixture below (and the
 * deterministic randomised cases) must hold, in cents:
 *   Balance due = Total - Paid (tenders) - Returned (own-return credit APPLIED to this order's invoices).
 * A refunded or kept credit is shown, never subtracted. The state (pending / settled) only gates the info lines.
 */
const ORDER = ["ADVANCE", "CASH", "CARD", "CHECK", "OTHER", "STORE_CREDIT"] as const;
const THIS = "ord-1";
/** the credit note as the batched read saw it: its status and the PAID amount applied to it on ANY sale */
const note = (status: string, appliedAnywhere = 0) => ({ status, appliedAnywhere });

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
  status: "REFUNDED",
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
    /** credit spent on another sale (Credit used), default 0 */
    used?: number;
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
    returns: [standard({ creditNoteId: "cn-1", creditNote: note("ISSUED") })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 2.5, pending: false, balance: 7.5 },
  },
  {
    name: "(1c) the credit is applied to this sale's invoice",
    total: 12.5,
    payments: [pay("CASH", 5), pay("STORE_CREDIT", 2.5, "cn-1")],
    returns: [standard({ creditNoteId: "cn-1", creditNote: note("APPLIED", 2.5) })],
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
    returns: [standard({ amount: 6.25, creditNoteId: "cn-1", creditNote: note("APPLIED", 6.25) })],
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
    returns: [standard({ amount: 3, creditNoteId: "cn-1", creditNote: note("ISSUED") })],
    expect: { paid: 12.5, applied: 0, refunded: 0, kept: 3, pending: false, balance: 0 },
  },
  {
    name: "a credit partly applied here: the rest is kept",
    total: 12.5,
    payments: [pay("CASH", 5), pay("STORE_CREDIT", 1, "cn-1")],
    returns: [standard({ creditNoteId: "cn-1", creditNote: note("APPLIED", 1) })],
    expect: { paid: 5, applied: 1, refunded: 0, kept: 1.5, pending: false, balance: 6.5 },
  },
  {
    name: "(3) sale A 12.50 all cash, its 5.50 credit spent on order B: Credit used 5.50, nothing kept, balance 0",
    total: 12.5,
    payments: [pay("CASH", 12.5)],
    returns: [standard({ amount: 5.5, creditNoteId: "cn-1", creditNote: note("APPLIED", 5.5) })],
    expect: { paid: 12.5, applied: 0, refunded: 0, kept: 0, pending: false, balance: 0, used: 5.5 },
  },
  {
    name: "credit partly spent on another sale: Credit used 1.00, Credit kept 1.50",
    total: 12.5,
    payments: [pay("CASH", 5)],
    returns: [standard({ creditNoteId: "cn-1", creditNote: note("APPLIED", 1) })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 1.5, pending: false, balance: 7.5, used: 1 },
  },
  {
    name: "a note the read did not see is not settled: Return in progress, never kept (I2)",
    total: 12.5,
    payments: [pay("CASH", 5)],
    returns: [standard({ creditNoteId: "cn-1" })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 0, pending: true, balance: 7.5 },
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
    name: "a voided credit note with no refund is DEAD (SA-838a M1): nothing printed, not pending",
    total: 12.5,
    payments: [pay("CASH", 5)],
    returns: [standard({ creditNoteId: "cn-1", creditNote: note("VOID") })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 0, pending: false, balance: 7.5 },
  },
  {
    name: "a note applied here and then voided is DEAD (M1): the application is reversed, the VOID payment is in no figure",
    total: 12.5,
    payments: [pay("CASH", 5), { ...pay("STORE_CREDIT", 2.5, "cn-1"), status: "VOID" }],
    returns: [standard({ creditNoteId: "cn-1", creditNote: note("VOID") })],
    expect: { paid: 5, applied: 0, refunded: 0, kept: 0, pending: false, balance: 7.5 },
  },
  {
    name: "a note voided while its PAID application still stands: DEAD, and the payment stays a tender (never hide money)",
    total: 12.5,
    payments: [pay("CASH", 5), pay("STORE_CREDIT", 2.5, "cn-1")],
    returns: [standard({ creditNoteId: "cn-1", creditNote: note("VOID") })],
    expect: { paid: 7.5, applied: 0, refunded: 0, kept: 0, pending: false, balance: 5 },
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
        status: "REFUNDED",
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
  const totals = settlementTotals(settlements);
  return {
    settlements,
    split,
    applied: totals.applied,
    refunded: totals.refunded,
    kept: totals.kept,
    used: totals.used,
    pending: totals.pending,
    // the stored balance: what the invoices still owe after EVERY paid payment, credit included
    balance: Math.max(
      0,
      roundMoney(
        f.total -
          roundMoney(
            f.payments.filter((p) => p.status === "PAID").reduce((t, p) => t + p.amount, 0),
          ),
      ),
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
    expect(r.used).toBe(f.expect.used ?? 0);
    expect(r.pending).toBe(f.expect.pending);
    expect(r.balance).toBe(f.expect.balance);
  });

  it("the state: a credit note issued and not VOID, or a completed external refund, is SETTLED", () => {
    const state = (over: Partial<SettlementReturn>) =>
      returnSettlement(standard(over), [], THIS).state;
    expect(state({ creditNoteId: "cn-1", creditNote: note("ISSUED") })).toBe("SETTLED");
    expect(state({ creditNoteId: "cn-1", creditNote: note("APPLIED", 2.5) })).toBe("SETTLED");
    // a note the batched read did NOT see is never claimed as a credit (no "unknown = issued" fallback)
    expect(state({ creditNoteId: "cn-1" })).toBe("PENDING");
    expect(state({ creditNoteId: "cn-1", creditNote: null })).toBe("PENDING");
    expect(state({ refundMethod: "EXTERNAL_REFUND", refundedAt: "2026-10-22T10:00:00Z" })).toBe(
      "SETTLED",
    );
    expect(state({ creditNoteId: "cn-1", creditNote: note("VOID") })).toBe("DEAD");
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
      standard({ creditNoteId: "cn-1", creditNote: note("APPLIED", 1) }),
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
      status: "REFUNDED",
      creditNoteId: "cn-2",
      creditNote: note("ISSUED"),
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
      returnSettlement(
        standard({ creditNoteId: "cn-1", creditNote: note("APPLIED", 2.5) }),
        [pay("STORE_CREDIT", 2.5, "cn-1")],
        THIS,
      ).creditNoteId,
    ).toBe("cn-1");
    expect(returnSettlement(standard(), [], THIS).creditNoteId).toBeNull();
  });
});

describe("the invariant: Balance due = Total - Paid (tenders) - Returned (applied), in cents", () => {
  const check = (f: Pick<Fixture, "total" | "payments" | "returns">) => {
    const r = read(f);
    const cents = (n: number) => Math.round(n * 100);
    // overpaid sales clamp at 0 and are outside the identity
    const paidAll = f.payments
      .filter((p) => p.status === "PAID")
      .reduce((t, p) => t + cents(p.amount), 0);
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
      standard({ creditNoteId: "cn-1", creditNote: note("ISSUED") }),
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
      const kind = next(6);
      const appliedC = kind === 2 ? worthC : kind === 3 ? next(worthC + 1) : 0;
      // credit spent on ANOTHER sale (kinds 3 to 5): the note's anywhere total is applied here plus used elsewhere
      const usedC = kind >= 3 ? next(worthC - appliedC + 1) : 0;
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
                creditNote:
                  kind === 4 && usedC === 0
                    ? note("ISSUED")
                    : note("APPLIED", dollars(appliedC + usedC)),
              });
      const f = { total: dollars(totalC), payments, returns: [ret] };
      check(f);
      const r = read(f);
      // a settled credit is shown once: applied + kept (credit) or refunded, never more than the return is worth
      expect(roundMoney(r.applied + r.refunded + r.kept + r.used)).toBeLessThanOrEqual(
        Math.max(dollars(worthC), r.applied),
      );
      expect(r.kept).toBeGreaterThanOrEqual(0);
      if (kind >= 3) {
        expect(r.used).toBe(dollars(usedC));
        // kept is what is left after BOTH applications: worth - applied anywhere
        expect(r.kept).toBe(dollars(worthC - appliedC - usedC));
      }
      if (kind === 1) expect(r.refunded).toBe(dollars(worthC));
      if (kind === 0) expect([r.applied, r.refunded, r.kept, r.pending]).toEqual([0, 0, 0, true]);
    }
  });
});

describe("SA-838a fix round 1", () => {
  const applied = (over: Partial<SettlementReturn> = {}) =>
    standard({ creditNoteId: "cn-1", creditNote: note("APPLIED", 2.5), ...over });

  it("M2: two settlements of ONE credit note count its application once (returnCredit == the own-credit PAID payments)", () => {
    const payments = [pay("CASH", 5), pay("STORE_CREDIT", 2.5, "cn-1")];
    const settlements = [
      returnSettlement(applied({ id: "r-1" }), payments, THIS),
      returnSettlement(applied({ id: "r-2" }), payments, THIS),
    ];
    expect(settlementTotals(settlements).applied).toBe(2.5);
    const split = counterTenderSplit(payments, settlements, ORDER);
    expect(split.returnCredit).toBe(2.5);
    expect(split.tenderPaid).toBe(5);
  });

  it("M2: returnCredit equals the sum of own-credit PAID payments in every pinned applied fixture", () => {
    for (const f of FIXTURES) {
      const r = read(f);
      const ownIds = new Set(r.settlements.flatMap((s) => (s.applied > 0 ? [s.creditNoteId] : [])));
      const paidOwn = roundMoney(
        f.payments
          .filter((p) => p.status === "PAID" && "creditNoteId" in p && ownIds.has(p.creditNoteId!))
          .reduce((t, p) => t + p.amount, 0),
      );
      expect(r.split.returnCredit).toBe(paidOwn);
    }
  });

  it("I2: a note the read saw as VOID prints nothing, even for a carried INLINE return", () => {
    const inline: SettlementReturn = {
      id: "ret-3",
      kind: "INLINE",
      orderId: "ord-carrier",
      status: "REFUNDED",
      creditNoteId: "cn-3",
      creditNote: note("VOID"),
      items: [{ sourceOrderId: THIS, subtotal: 5, taxAmount: 0, categoryTax: 0 }],
    };
    expect(returnSettlement(inline, [], THIS)).toMatchObject({
      state: "DEAD",
      applied: 0,
      refunded: 0,
      kept: 0,
    });
  });

  it("I2: a minted note the read did not return is not settled (never claim a credit you cannot see)", () => {
    expect(returnSettlement(standard({ creditNoteId: "cn-9" }), [], THIS)).toMatchObject({
      state: "PENDING",
      kept: 0,
    });
  });

  it("I1: kept is worth - applied ANYWHERE - refunded; the part spent on another sale is appliedElsewhere", () => {
    // worth 2.50; 1.00 applied here, 0.50 applied on another sale
    const s = returnSettlement(
      applied({ creditNote: note("APPLIED", 1.5) }),
      [pay("STORE_CREDIT", 1, "cn-1")],
      THIS,
    );
    expect(s).toMatchObject({ applied: 1, appliedElsewhere: 0.5, refunded: 0, kept: 1 });
  });

  it("I1: credit spent entirely on another sale is Credit used, not kept, and nothing is applied here", () => {
    const s = returnSettlement(applied({ creditNote: note("APPLIED", 2.5) }), [], THIS);
    expect(s).toMatchObject({ state: "SETTLED", applied: 0, appliedElsewhere: 2.5, kept: 0 });
  });

  it("I1 data: a refunded return has nothing on the account", () => {
    const s = returnSettlement(
      standard({ status: "REFUNDED", refundMethod: "EXTERNAL_REFUND", refundedAt: "2026-10-22" }),
      [],
      THIS,
    );
    expect(s).toMatchObject({ appliedElsewhere: 0, kept: 0, refunded: 2.5 });
  });
});
