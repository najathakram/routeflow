import { TODAYS_SALE_METHOD_VALUES } from "@routeflow/types";
import {
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

const ret = (over: Partial<Ret> = {}): Ret => ({
  id: "r-1",
  returnNumber: "RET-1",
  status: "PROCESSED",
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
  status: "PROCESSED",
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
    status: "PROCESSED",
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
