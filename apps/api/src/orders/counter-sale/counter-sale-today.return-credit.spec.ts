import { TODAYS_SALE_METHOD_VALUES } from "@routeflow/types";
import { DEAD_RETURN_STATUS_VALUES } from "@routeflow/pricing";
import {
  DEAD_RETURN_STATUSES,
  TODAYS_SALE_METHOD_ORDER,
  ownReturnCreditNoteIds,
  toTodaysSaleRow,
  todaysMethodOf,
  type ReturnProvenance,
  type TodayOrderRecord,
} from "./counter-sale-today";

/**
 * B1262 / SA-838: which of a sale's credit-note payments are its OWN return credit (the return settling the invoice,
 * not a tender), and the row's split of tenders from that credit. Pure: the fixtures are the shapes the page query
 * `select`s. Placeholders only (acme).
 */
type Pay = {
  method: string;
  amount: unknown;
  status: string;
  creditNoteId?: string | null;
  creditNote?: { invoiceId: string | null } | null;
};
type Ret = TodayOrderRecord["returns"][number];

const pay = (method: string, amount: number): Pay => ({ method, amount, status: "PAID" });
/** a credit-note application: the note id and the invoice the NOTE was issued against */
const creditPay = (amount: number, noteId: string, noteInvoiceId: string | null = "i-1"): Pay => ({
  method: "CREDIT_NOTE",
  amount,
  status: "PAID",
  creditNoteId: noteId,
  creditNote: { invoiceId: noteInvoiceId },
});

/** the batched credit-note read's answer: note id -> [status, PAID amount applied on ANY sale] */
const notes = (entries: Record<string, [string, number]>) =>
  new Map(
    Object.entries(entries).map(([id, [status, appliedAnywhere]]) => [
      id,
      { status, appliedAnywhere },
    ]),
  );

const ret = (over: Partial<Ret> = {}): Ret => ({
  id: "r-1",
  returnNumber: "RET-1",
  status: "REFUNDED",
  refundMethod: "CREDIT_NOTE",
  creditNoteId: "cn-1",
  refundAmount: null,
  creditSubtotal: "6.25",
  creditTax: "0.00",
  creditCategoryTax: "0.00",
  ...over,
});

function order(payments: Pay[], returns: Ret[] = [], total = "12.50"): TodayOrderRecord {
  return {
    id: "o-1",
    orderNumber: "1042",
    status: "DELIVERED",
    total,
    createdAt: new Date("2026-10-07T18:14:00.000Z"),
    customerId: "c-1",
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    invoices: [{ id: "i-1", invoiceNumber: "INV-1", status: "PAID", payments }],
    returns,
  };
}

/** a return carried on ANOTHER order (an INLINE return), the goods sold on this one */
const carried = (over: Partial<ReturnProvenance> = {}): ReturnProvenance => ({
  creditNoteId: "cn-1",
  orderId: "o-2",
  kind: "INLINE",
  status: "REFUNDED",
  items: [{ sourceOrderId: "o-1" }],
  ...over,
});

describe("ADVANCE is its own till method (SA-838 amendment 2)", () => {
  it("an advance application reads ADVANCE, not STORE_CREDIT; a credit note stays STORE_CREDIT", () => {
    expect(todaysMethodOf("ADVANCE")).toBe("ADVANCE");
    expect(todaysMethodOf("CREDIT_NOTE")).toBe("STORE_CREDIT");
  });
});

describe("the display-method list parity pin (SA-838)", () => {
  it("the API's receipt order is the shared list in @routeflow/types, element for element", () => {
    expect([...TODAYS_SALE_METHOD_ORDER]).toEqual([...TODAYS_SALE_METHOD_VALUES]);
    expect(TODAYS_SALE_METHOD_VALUES).toContain("ADVANCE");
  });
});

describe("toTodaysSaleRow: tender split (SA-838 red set)", () => {
  it("(a) $12.50 on account, $6.25 returned as credit, $6.25 cash: the own return credit is not a tender", () => {
    const row = toTodaysSaleRow(order([pay("CASH", 6.25), creditPay(6.25, "cn-1")], [ret()]));
    expect(row.paid).toBe(12.5);
    expect(row.tenderPaid).toBe(6.25);
    expect(row.returnCredit).toBe(6.25);
    expect(row.tenderMethods).toEqual([{ method: "CASH", amount: 6.25 }]);
    expect(row.returned.amount).toBe(6.25);
  });

  it("(b) a $5 advance and $7.50 cash with a $2.50 refund paid outside: both are tenders", () => {
    const row = toTodaysSaleRow(
      order(
        [pay("ADVANCE", 5), pay("CASH", 7.5)],
        [
          ret({
            refundMethod: "EXTERNAL_REFUND",
            creditNoteId: null,
            refundAmount: "2.50",
            creditSubtotal: "2.50",
            refundedAt: new Date("2026-10-07T19:00:00.000Z"),
          }),
        ],
      ),
    );
    expect(row.tenderPaid).toBe(12.5);
    expect(row.returnCredit).toBe(0);
    // prepaid money lists first (the SA's pinned receipt reads "Advance $5.00 · Cash $7.50")
    expect(row.tenderMethods).toEqual([
      { method: "ADVANCE", amount: 5 },
      { method: "CASH", amount: 7.5 },
    ]);
    expect(row.methods).toEqual([
      { method: "ADVANCE", amount: 5 },
      { method: "CASH", amount: 7.5 },
    ]);
    expect(row.returned.returns.map((r) => r.resolution)).toEqual(["REFUND"]);
  });

  it("(c) paid fully from an advance, then partly returned for store credit that was not applied here", () => {
    const row = toTodaysSaleRow(
      order([pay("ADVANCE", 12.5)], [ret({ creditNoteId: "cn-wallet", creditSubtotal: "3.00" })]),
    );
    expect(row.tenderPaid).toBe(12.5);
    expect(row.returnCredit).toBe(0);
    expect(row.tenderMethods).toEqual([{ method: "ADVANCE", amount: 12.5 }]);
    expect(row.returned.amount).toBe(3);
  });

  it("(d) store credit from ANOTHER order's return stays the tender Store credit", () => {
    const row = toTodaysSaleRow(
      order([pay("CASH", 8.5), creditPay(4, "cn-other")], [ret({ creditNoteId: "cn-1" })]),
    );
    expect(row.tenderPaid).toBe(12.5);
    expect(row.returnCredit).toBe(0);
    expect(row.tenderMethods).toEqual([
      { method: "CASH", amount: 8.5 },
      { method: "STORE_CREDIT", amount: 4 },
    ]);
  });

  it("(e) an INLINE return carried on another order, sourced from this one, is this order's return credit", () => {
    const row = toTodaysSaleRow(order([pay("CASH", 6.25), creditPay(6.25, "cn-1")], []), null, [
      carried(),
    ]);
    expect(row.tenderPaid).toBe(6.25);
    expect(row.returnCredit).toBe(6.25);
    expect(row.tenderMethods).toEqual([{ method: "CASH", amount: 6.25 }]);
  });

  it("(f) the links disagree: the credit note was issued against another invoice, so it is a tender", () => {
    const row = toTodaysSaleRow(
      order([pay("CASH", 6.25), creditPay(6.25, "cn-1", "i-elsewhere")], [ret()]),
    );
    expect(row.tenderPaid).toBe(12.5);
    expect(row.returnCredit).toBe(0);
    expect(row.tenderMethods).toEqual([
      { method: "CASH", amount: 6.25 },
      { method: "STORE_CREDIT", amount: 6.25 },
    ]);
  });

  it("(f) the links disagree: no return of this order made that credit note, so it is a tender", () => {
    const row = toTodaysSaleRow(order([pay("CASH", 6.25), creditPay(6.25, "cn-1")], []));
    expect(row.tenderPaid).toBe(12.5);
    expect(row.returnCredit).toBe(0);
  });

  it("a credit note with no recorded invoice (the note's invoice link is missing) is a tender", () => {
    const row = toTodaysSaleRow(order([pay("CASH", 6.25), creditPay(6.25, "cn-1", null)], [ret()]));
    expect(row.tenderPaid).toBe(12.5);
    expect(row.returnCredit).toBe(0);
  });

  it("a record without the provenance fields (a hand-built or older shape) splits as all tender", () => {
    const row = toTodaysSaleRow(order([pay("CASH", 6.25), pay("CREDIT_NOTE", 6.25)], [ret()]));
    expect(row.tenderPaid).toBe(12.5);
    expect(row.returnCredit).toBe(0);
  });
});

describe("ownReturnCreditNoteIds (SA-838 provenance: both links, or it is a tender)", () => {
  const base = {
    orderId: "o-1",
    invoiceIds: ["i-1"],
    payments: [creditPay(6.25, "cn-1")],
  };
  const standard = (over: Partial<ReturnProvenance> = {}): ReturnProvenance => ({
    creditNoteId: "cn-1",
    orderId: "o-1",
    kind: "STANDARD",
    status: "REFUNDED",
    ...over,
  });

  it("a STANDARD return of this order made the note, and the note is on this order's invoice", () => {
    expect([...ownReturnCreditNoteIds({ ...base, returns: [standard()] })]).toEqual(["cn-1"]);
  });

  it("a return with no kind reads STANDARD", () => {
    const { kind: _kind, ...noKind } = standard();
    expect([...ownReturnCreditNoteIds({ ...base, returns: [noKind] })]).toEqual(["cn-1"]);
  });

  it("an INLINE return carried on another order counts only through an item sourced from this order", () => {
    expect([...ownReturnCreditNoteIds({ ...base, returns: [carried()] })]).toEqual(["cn-1"]);
    expect(
      ownReturnCreditNoteIds({
        ...base,
        returns: [carried({ items: [{ sourceOrderId: "o-3" }, { sourceOrderId: null }] })],
      }).size,
    ).toBe(0);
    expect(ownReturnCreditNoteIds({ ...base, returns: [carried({ items: [] })] }).size).toBe(0);
    expect(ownReturnCreditNoteIds({ ...base, returns: [carried({ items: undefined })] }).size).toBe(
      0,
    );
  });

  it("an INLINE return carried ON this order but sold on another order is not this order's", () => {
    expect(
      ownReturnCreditNoteIds({
        ...base,
        returns: [carried({ orderId: "o-1", items: [{ sourceOrderId: "o-9" }] })],
      }).size,
    ).toBe(0);
  });

  it("an INLINE return carried on this order AND sold on it counts", () => {
    expect(
      ownReturnCreditNoteIds({
        ...base,
        returns: [carried({ orderId: "o-1", items: [{ sourceOrderId: "o-1" }] })],
      }).size,
    ).toBe(1);
  });

  it("a STANDARD return of another order never counts", () => {
    expect(ownReturnCreditNoteIds({ ...base, returns: [standard({ orderId: "o-2" })] }).size).toBe(
      0,
    );
  });

  it("a rejected or cancelled return never counts (its credit stays a tender)", () => {
    for (const status of ["REJECTED", "CANCELLED"]) {
      expect(ownReturnCreditNoteIds({ ...base, returns: [standard({ status })] }).size).toBe(0);
    }
  });

  it("the note must be on one of this order's invoices; a missing or foreign invoice id disagrees", () => {
    for (const noteInvoiceId of [null, "i-9"]) {
      expect(
        ownReturnCreditNoteIds({
          ...base,
          payments: [creditPay(6.25, "cn-1", noteInvoiceId)],
          returns: [standard()],
        }).size,
      ).toBe(0);
    }
    expect(
      ownReturnCreditNoteIds({
        ...base,
        invoiceIds: ["i-1", "i-2"],
        payments: [creditPay(6.25, "cn-1", "i-2")],
        returns: [standard()],
      }).size,
    ).toBe(1);
  });

  it("a payment that applied no credit note is never considered", () => {
    expect(
      ownReturnCreditNoteIds({ ...base, payments: [pay("CASH", 5)], returns: [standard()] }).size,
    ).toBe(0);
  });

  it("a return with no credit note id (an external refund) makes nothing", () => {
    expect(
      ownReturnCreditNoteIds({ ...base, returns: [standard({ creditNoteId: null })] }).size,
    ).toBe(0);
  });
});

describe("toTodaysSaleRow: returnLines, what THIS order's own return did (SA-838a)", () => {
  /** an INLINE return filed on carrier order B, its goods sold on sale A, priced per item */
  const inlineOfA = (over: Partial<ReturnProvenance> = {}): ReturnProvenance => ({
    id: "r-inline",
    creditNoteId: "cn-1",
    orderId: "o-b",
    kind: "INLINE",
    status: "REFUNDED",
    refundMethod: "CREDIT_NOTE",
    items: [{ sourceOrderId: "o-1", subtotal: "5.00", taxAmount: "0.50", categoryTax: "0.00" }],
    ...over,
  });
  const refunded = (over: Partial<Ret> = {}): Ret =>
    ret({
      id: "r-ref",
      status: "REFUNDED",
      refundMethod: "EXTERNAL_REFUND",
      creditNoteId: null,
      refundAmount: "2.50",
      creditSubtotal: "2.50",
      creditTax: "0",
      refundedAt: new Date("2026-10-07T19:00:00.000Z"),
      ...over,
    });
  const own250 = (over: Partial<Ret> = {}): Ret =>
    ret({ creditSubtotal: "2.50", creditNoteId: "cn-1", ...over });
  const go = (
    rec: TodayOrderRecord,
    seen: ReturnType<typeof notes> = notes({}),
    carriedRets: ReturnProvenance[] = [],
  ) => toTodaysSaleRow(rec, null, carriedRets, seen);
  const lines = (r: ReturnType<typeof toTodaysSaleRow>) => r.returnLines;
  const L = (
    applied: number,
    refundedAmt: number,
    kept: number,
    used: number,
    pending: boolean,
  ) => ({
    applied,
    refunded: refundedAmt,
    kept,
    used,
    pending,
  });

  it("(1a) Total 12.50, Cash 5.00, own return 2.50 refunded outside: Refunded 2.50, Balance due 7.50", () => {
    const row = go(order([pay("CASH", 5)], [refunded()]));
    expect(lines(row)).toEqual(L(0, 2.5, 0, 0, false));
    expect(row.tenderPaid).toBe(5);
    expect(row.balanceDue).toBe(7.5);
  });

  it("(1b) the credit is kept on the account: Credit kept 2.50, Balance due 7.50", () => {
    const row = go(order([pay("CASH", 5)], [own250()]), notes({ "cn-1": ["ISSUED", 0] }));
    expect(lines(row)).toEqual(L(0, 0, 2.5, 0, false));
    expect(row.balanceDue).toBe(7.5);
  });

  it("(1c) the credit is applied to this sale: Returned 2.50, Balance due 5.00", () => {
    const row = go(
      order([pay("CASH", 5), creditPay(2.5, "cn-1")], [own250()]),
      notes({ "cn-1": ["APPLIED", 2.5] }),
    );
    expect(lines(row)).toEqual(L(2.5, 0, 0, 0, false));
    expect(row.tenderPaid).toBe(5);
    expect(row.returnCredit).toBe(2.5);
    expect(row.balanceDue).toBe(5);
  });

  it("(2) the return is still pending: nothing subtracted, pending is true", () => {
    for (const status of ["PENDING", "APPROVED", "IN_TRANSIT"]) {
      const row = go(
        order(
          [pay("CASH", 5)],
          [ret({ status, refundMethod: null, creditNoteId: null, creditSubtotal: "2.50" })],
        ),
      );
      expect(lines(row)).toEqual(L(0, 0, 0, 0, true));
      expect(row.balanceDue).toBe(7.5);
    }
  });

  it("a refund chosen but not recorded yet is still pending, not Refunded", () => {
    const row = go(order([pay("CASH", 5)], [refunded({ refundedAt: null })]));
    expect(lines(row)).toEqual(L(0, 0, 0, 0, true));
  });

  it("(a) on account 12.50, 6.25 returned and applied, 6.25 cash: Returned 6.25, balance 0", () => {
    const row = go(
      order([pay("CASH", 6.25), creditPay(6.25, "cn-1")], [ret()]),
      notes({ "cn-1": ["APPLIED", 6.25] }),
    );
    expect(lines(row)).toEqual(L(6.25, 0, 0, 0, false));
    expect(row.balanceDue).toBe(0);
  });

  it("(b) 5.00 advance + 7.50 cash, 2.50 refunded outside: Refunded 2.50, Paid 12.50", () => {
    const row = go(order([pay("ADVANCE", 5), pay("CASH", 7.5)], [refunded()]));
    expect(lines(row)).toEqual(L(0, 2.5, 0, 0, false));
    expect(row.tenderPaid).toBe(12.5);
  });

  it("(c) paid fully from an advance, 3.00 returned and kept: Credit kept 3.00", () => {
    const row = go(
      order([pay("ADVANCE", 12.5)], [ret({ creditNoteId: "cn-wallet", creditSubtotal: "3.00" })]),
      notes({ "cn-wallet": ["ISSUED", 0] }),
    );
    expect(lines(row)).toEqual(L(0, 0, 3, 0, false));
  });

  it("a credit partly applied here shows Returned for the part applied and Credit kept for the rest", () => {
    const row = go(
      order([pay("CASH", 5), creditPay(1, "cn-1")], [own250()]),
      notes({ "cn-1": ["APPLIED", 1] }),
    );
    expect(lines(row)).toEqual(L(1, 0, 1.5, 0, false));
    expect(row.balanceDue).toBe(6.5);
  });

  it("(3) I1: sale A 12.50 all cash, its 5.50 credit spent on order B: Credit used 5.50, nothing kept, no balance", () => {
    const row = go(
      order([pay("CASH", 12.5)], [ret({ creditSubtotal: "5.50" })]),
      notes({ "cn-1": ["APPLIED", 5.5] }),
    );
    expect(lines(row)).toEqual(L(0, 0, 0, 5.5, false));
    expect(row.balanceDue).toBe(0);
    expect(row.tenderPaid).toBe(12.5);
  });

  it("I1: credit partly used elsewhere: Credit used for the part spent, Credit kept for the rest", () => {
    const row = go(order([pay("CASH", 5)], [own250()]), notes({ "cn-1": ["APPLIED", 1] }));
    expect(lines(row)).toEqual(L(0, 0, 1.5, 1, false));
  });

  it("I2: a note the batched read did not return is not settled: pending, never kept", () => {
    const row = go(order([pay("CASH", 5)], [own250()]), notes({}));
    expect(lines(row)).toEqual(L(0, 0, 0, 0, true));
  });

  it("M1: a VOID note with no refund prints nothing (own return), applied then voided included", () => {
    const kept = go(order([pay("CASH", 5)], [own250()]), notes({ "cn-1": ["VOID", 0] }));
    expect(lines(kept)).toEqual(L(0, 0, 0, 0, false));
    // the PAID application still stands under a VOID note: it stays a tender (never hide money), the balance is the stored one
    const stood = go(
      order([pay("CASH", 5), creditPay(2.5, "cn-1")], [own250()]),
      notes({ "cn-1": ["VOID", 2.5] }),
    );
    expect(lines(stood)).toEqual(L(0, 0, 0, 0, false));
    expect(stood.returnCredit).toBe(0);
    expect(stood.tenderPaid).toBe(7.5);
    expect(stood.balanceDue).toBe(5);
  });

  it("I2: a carried INLINE return whose note is VOID prints nothing", () => {
    const row = go(
      order([pay("CASH", 6.25), creditPay(5.5, "cn-1")], []),
      notes({ "cn-1": ["VOID", 0] }),
      [inlineOfA()],
    );
    expect(lines(row)).toEqual(L(0, 0, 0, 0, false));
  });

  it("sale A: its own INLINE return, carried on B, applied here: Returned 5.50", () => {
    const row = go(
      order([pay("CASH", 6.25), creditPay(5.5, "cn-1")], []),
      notes({ "cn-1": ["APPLIED", 5.5] }),
      [inlineOfA()],
    );
    expect(lines(row)).toEqual(L(5.5, 0, 0, 0, false));
  });

  it("carrier B: holds the INLINE return (row.returned counts it) but returnLines are all zero", () => {
    const carrier: TodayOrderRecord = {
      ...order(
        [pay("CASH", 12.5)],
        [ret({ id: "r-inline", creditNoteId: "cn-1", creditSubtotal: "5.00", creditTax: "0.50" })],
      ),
      id: "o-b",
    };
    carrier.returns = [
      {
        ...carrier.returns[0]!,
        kind: "INLINE",
        items: [{ sourceOrderId: "o-1", subtotal: "5.00", taxAmount: "0.50", categoryTax: "0.00" }],
      },
    ];
    const row = go(carrier, notes({ "cn-1": ["ISSUED", 0] }));
    expect(row.returned.amount).toBe(5.5);
    expect(lines(row)).toEqual(L(0, 0, 0, 0, false));
    expect(row.tenderPaid).toBe(12.5);
    expect(row.returnCredit).toBe(0);
  });

  it("one return seen twice (the page's and the batched read) counts once", () => {
    const row = go(
      order([pay("CASH", 6.25), creditPay(6.25, "cn-1")], [ret({ id: "r-1" })]),
      notes({ "cn-1": ["APPLIED", 6.25] }),
      [{ id: "r-1", creditNoteId: "cn-1", orderId: "o-1", kind: "STANDARD", status: "REFUNDED" }],
    );
    expect(lines(row)).toEqual(L(6.25, 0, 0, 0, false));
  });

  it("M2: two returns naming ONE note count its application once: returnCredit is the own-credit PAID payments", () => {
    const row = go(
      order(
        [pay("CASH", 5), creditPay(2.5, "cn-1")],
        [own250({ id: "r-1" }), own250({ id: "r-2" })],
      ),
      notes({ "cn-1": ["APPLIED", 2.5] }),
    );
    expect(row.returnCredit).toBe(2.5);
    expect(lines(row)?.applied).toBe(2.5);
    expect(row.tenderPaid).toBe(5);
  });

  it("a rejected or cancelled return is no one's return: DEAD prints nothing", () => {
    const row = go(order([pay("CASH", 12.5)], [ret({ status: "REJECTED" })]), notes({}), [
      inlineOfA({ status: "CANCELLED" }),
    ]);
    expect(lines(row)).toEqual(L(0, 0, 0, 0, false));
  });

  it("two own returns add up: one applied, one refunded, one pending", () => {
    const row = go(
      order(
        [pay("CASH", 5), creditPay(2.5, "cn-1")],
        [
          own250({ id: "r-1" }),
          refunded({ id: "r-2" }),
          ret({ id: "r-3", status: "PENDING", refundMethod: null, creditNoteId: null }),
        ],
      ),
      notes({ "cn-1": ["APPLIED", 2.5] }),
    );
    expect(lines(row)).toEqual(L(2.5, 2.5, 0, 0, true));
  });

  it("DEAD_RETURN_STATUS_VALUES (pricing) is the API's DEAD_RETURN_STATUSES, element for element", () => {
    expect([...DEAD_RETURN_STATUS_VALUES]).toEqual([...DEAD_RETURN_STATUSES]);
  });
});

describe("toTodaysSaleRow: the receipt invariant over every fixture (SA-838a, in cents)", () => {
  const cents = (n: number) => Math.round(n * 100);
  const refundedRet = ret({
    id: "r-ref",
    status: "REFUNDED",
    refundMethod: "EXTERNAL_REFUND",
    creditNoteId: null,
    creditSubtotal: "2.50",
    refundedAt: new Date("2026-10-07T19:00:00.000Z"),
  });
  const pendingRet = ret({ status: "PENDING", refundMethod: null, creditNoteId: null });
  type Seen = ReturnType<typeof notes>;
  const inline: ReturnProvenance = {
    id: "r-inline",
    creditNoteId: "cn-1",
    orderId: "o-b",
    kind: "INLINE",
    status: "REFUNDED",
    items: [{ sourceOrderId: "o-1", subtotal: "5.00", taxAmount: "0.50", categoryTax: "0" }],
  };
  const fixtures: Array<readonly [string, TodayOrderRecord, Seen, ReturnProvenance[]]> = [
    ["1a refunded", order([pay("CASH", 5)], [refundedRet]), notes({}), []],
    [
      "1b kept",
      order([pay("CASH", 5)], [ret({ creditSubtotal: "2.50" })]),
      notes({ "cn-1": ["ISSUED", 0] }),
      [],
    ],
    [
      "1c applied",
      order([pay("CASH", 5), creditPay(2.5, "cn-1")], [ret({ creditSubtotal: "2.50" })]),
      notes({ "cn-1": ["APPLIED", 2.5] }),
      [],
    ],
    ["2 pending", order([pay("CASH", 5)], [pendingRet]), notes({}), []],
    [
      "a",
      order([pay("CASH", 6.25), creditPay(6.25, "cn-1")], [ret()]),
      notes({ "cn-1": ["APPLIED", 6.25] }),
      [],
    ],
    ["b", order([pay("ADVANCE", 5), pay("CASH", 7.5)], [refundedRet]), notes({}), []],
    [
      "c",
      order([pay("ADVANCE", 12.5)], [ret({ creditNoteId: "cn-w", creditSubtotal: "3.00" })]),
      notes({ "cn-w": ["ISSUED", 0] }),
      [],
    ],
    [
      "3 credit used on B",
      order([pay("CASH", 12.5)], [ret({ creditSubtotal: "5.50" })]),
      notes({ "cn-1": ["APPLIED", 5.5] }),
      [],
    ],
    [
      "voided note, application stands",
      order([pay("CASH", 5), creditPay(2.5, "cn-1")], [ret({ creditSubtotal: "2.50" })]),
      notes({ "cn-1": ["VOID", 2.5] }),
      [],
    ],
    [
      "d",
      order([pay("CASH", 8.5), creditPay(4, "cn-other")], [ret()]),
      notes({ "cn-1": ["ISSUED", 0] }),
      [],
    ],
    ["no return", order([pay("CASH", 5)], []), notes({}), []],
    [
      "inline",
      order([pay("CASH", 7), creditPay(5.5, "cn-1")], []),
      notes({ "cn-1": ["APPLIED", 5.5] }),
      [inline],
    ],
  ];

  it.each(fixtures)("%s: Balance due = Total - Paid - Returned", (_n, rec, seen, carriedRets) => {
    const row = toTodaysSaleRow(rec, null, [...carriedRets], seen);
    const applied = row.returnLines?.applied ?? NaN;
    expect(cents(row.balanceDue)).toBe(cents(row.total) - cents(row.tenderPaid!) - cents(applied));
    expect(cents(row.tenderPaid!) + cents(row.returnCredit!)).toBe(cents(row.paid));
    expect(row.returnCredit).toBe(applied);
  });
});
