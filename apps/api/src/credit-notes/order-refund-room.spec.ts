import { loadOrderRefundRoom, orderRoomRefusal } from "./line-credit-headroom";

/**
 * SA-1091 piece 1: the arithmetic of the order-wide room, on a fake client (the real-Postgres rows are in
 * returns/order-refund-bound-sa1091.db.spec.ts). Every figure is gross.
 */
type Row = Record<string, unknown>;

function fakeDb(
  state: {
    invoices?: Row[];
    lines?: Row[];
    inlineItems?: Row[];
    notes?: Row[];
    external?: Row[];
    unlinked?: { returns: Row[]; notes: Row[] };
  } = {},
) {
  const calls: Record<string, Row[]> = {};
  const log = (name: string, arg: Row) => (calls[name] ??= []).push(arg);
  const db = {
    invoice: {
      findMany: jest.fn(async (arg: Row) => {
        log("invoice", arg);
        return state.invoices ?? [];
      }),
    },
    invoiceItem: {
      findMany: jest.fn(async (arg: Row) => {
        log("invoiceItem", arg);
        return state.lines ?? [];
      }),
    },
    returnItem: {
      findMany: jest.fn(async (arg: Row) => {
        log("returnItem", arg);
        return state.inlineItems ?? [];
      }),
    },
    creditNote: {
      findMany: jest.fn(async (arg: Row) => {
        log("creditNote", arg);
        // the unlinked-refund helper asks for `invoiceId: null`; the notes-on-invoices read asks for `invoiceId: {in}`
        return (arg.where as Row).invoiceId === null
          ? (state.unlinked?.notes ?? [])
          : (state.notes ?? []);
      }),
    },
    return: {
      findMany: jest.fn(async (arg: Row) => {
        log("return", arg);
        const where = arg.where as Row;
        return where.refundMethod === "EXTERNAL_REFUND"
          ? (state.external ?? [])
          : (state.unlinked?.returns ?? []);
      }),
    },
  };
  return { db, calls };
}

describe("SA-1091 loadOrderRefundRoom", () => {
  it("is null when the order has no creditable invoice (no bound)", async () => {
    const { db } = fakeDb({ invoices: [] });
    expect(await loadOrderRefundRoom(db, { orderId: "o1" })).toBeNull();
    expect(await loadOrderRefundRoom(db, {})).toBeNull();
  });

  it("billed minus the notes on the invoices, a recorded refund and an inline return, all gross", async () => {
    const { db } = fakeDb({
      invoices: [
        { id: "i1", total: "60.00" },
        { id: "i2", total: "40.00" },
      ],
      notes: [
        { id: "n1", amount: "5.00" },
        { id: "n2", amount: "2.50" },
      ],
      external: [{ refundAmount: "10.00" }],
      lines: [{ id: "l1" }],
      // 12.00 net + 1.20 tax + 0.30 category tax = 13.50 gross
      inlineItems: [{ subtotal: "12.00", taxAmount: "1.20", categoryTax: "0.30", return: null }],
    });
    const room = await loadOrderRefundRoom(db, { orderId: "o1" });
    expect(room).toEqual({
      billed: 100,
      given: { notes: 7.5, unlinked: 0, recorded: 10, inline: 13.5 },
      room: 69,
    });
  });

  it("RR-9: an inline return's note, should it sit on an invoice, is counted once (by the return)", async () => {
    const { db } = fakeDb({
      invoices: [{ id: "i1", total: "20.00" }],
      lines: [{ id: "l1" }],
      inlineItems: [
        {
          subtotal: "10.00",
          taxAmount: "0",
          categoryTax: "0",
          return: { creditNoteId: "n-inline" },
        },
      ],
      notes: [{ id: "n-inline", amount: "10.00" }],
    });
    const room = await loadOrderRefundRoom(db, { orderId: "o1" });
    expect(room?.given).toEqual({ notes: 0, unlinked: 0, recorded: 0, inline: 10 });
    expect(room?.room).toBe(10);
  });

  it("RR-7: a VOID note, a CANCELLED or REJECTED inline return and the return itself are left out by the queries", async () => {
    const { db, calls } = fakeDb({
      invoices: [{ id: "i1", total: "20.00" }],
      lines: [{ id: "l1" }],
    });
    await loadOrderRefundRoom(
      db,
      { orderId: "o1" },
      { excludeCreditNoteId: "cn1", excludeReturnId: "r1" },
    );
    const noteWhere = calls.creditNote.find((c) => (c.where as Row).invoiceId !== null)!
      .where as Row;
    expect(noteWhere.status).toEqual({ not: "VOID" });
    expect(noteWhere.id).toEqual({ not: "cn1" });
    const inlineWhere = (calls.returnItem[0].where as Row).return as Row;
    expect(inlineWhere.kind).toBe("INLINE");
    expect(inlineWhere.status).toEqual({ notIn: ["CANCELLED", "REJECTED"] });
    expect(inlineWhere.id).toEqual({ not: "r1" });
    const externalWhere = calls.return.find(
      (c) => (c.where as Row).refundMethod === "EXTERNAL_REFUND",
    )!.where as Row;
    expect(externalWhere).toMatchObject({
      orderId: "o1",
      kind: { not: "INLINE" },
      creditNoteId: null,
      status: "REFUNDED",
      id: { not: "r1" },
    });
  });

  it("RR-8: a note with no invoice counts nothing — only notes ON the order's invoices are read", async () => {
    const { db, calls } = fakeDb({ invoices: [{ id: "i1", total: "20.00" }] });
    await loadOrderRefundRoom(db, { orderId: "o1" });
    const onInvoices = calls.creditNote.find((c) => (c.where as Row).invoiceId !== null)!
      .where as Row;
    expect(onInvoices.invoiceId).toEqual({ in: ["i1"] });
  });

  it("an invoice with no order is its own bound and reads no order-scoped returns", async () => {
    const { db, calls } = fakeDb({ invoices: [{ id: "i9", total: "20.00" }] });
    const room = await loadOrderRefundRoom(db, { orderId: null, invoiceId: "i9" });
    expect(room?.room).toBe(20);
    expect(calls.return).toBeUndefined();
  });

  it("an order already over the bound reports negative room, and its left is never below 0", async () => {
    const { db } = fakeDb({
      invoices: [{ id: "i1", total: "20.00" }],
      notes: [{ id: "n1", amount: "25.00" }],
    });
    const room = await loadOrderRefundRoom(db, { orderId: "o1" });
    expect(room?.room).toBe(-5);
    expect(orderRoomRefusal(room, 0.01)?.left).toBe(0);
  });
});

describe("SA-1091 orderRoomRefusal", () => {
  const room = { billed: 20, given: { notes: 5, unlinked: 0, recorded: 0, inline: 0 }, room: 15 };

  it("RR-6: 15.00 fits in 15.00 of room, 15.01 does not, and the message says how much is left", () => {
    expect(orderRoomRefusal(room, 15)).toBeNull();
    const refusal = orderRoomRefusal(room, 15.01);
    expect(refusal?.left).toBe(15);
    expect(refusal?.message).toContain("15.00 is left");
    expect(refusal?.message).toContain("20.00");
  });

  it("no room read (no creditable invoice) refuses nothing", () => {
    expect(orderRoomRefusal(null, 1_000_000)).toBeNull();
  });

  it("names the refunds minted before the order was invoiced, when there are any", () => {
    const withUnlinked = { ...room, given: { ...room.given, unlinked: 5 }, room: 10 };
    expect(orderRoomRefusal(withUnlinked, 11)?.message).toContain(
      "already refunded as store credit",
    );
    expect(orderRoomRefusal(room, 16)?.message).not.toContain("already refunded as store credit");
  });
});
