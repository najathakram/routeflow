/**
 * SA-235 — finalizeOrderRecompute writes the Order row, and a cancelled orphan, ONLY when a column it would
 * write differs. A save that changes nothing moves no updatedAt (asserted by writes here, and by updatedAt in
 * the DB spec); a save that DOES change a figure still writes.
 */
import { finalizeOrderRecompute } from "./finalize-order-recompute";

const basis = { byLineId: new Map<string, number>(), hasMutations: false } as any;
const mkDb = () => ({ order: { update: jest.fn() }, orderItem: { update: jest.fn() } }) as any;
const run = (db: any, over: any = {}) =>
  finalizeOrderRecompute({
    db,
    orderId: "o1",
    order: { subtotal: "60.00", tax: "0.00", total: "65.00", shippingFee: "5.00" },
    deliveredBasis: basis,
    unbilled: new Map(),
    subtotal: 60,
    categoryTaxSum: 0,
    invoices: [{ shippingFee: 5 }],
    ...over,
  });

describe("finalizeOrderRecompute — identical writes are skipped (SA-235)", () => {
  it("the Order row is NOT written when subtotal, tax, total and shippingFee already hold the value", async () => {
    const db = mkDb();
    await run(db);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("the Order row IS written when any of them differs (a shrunk subtotal, a moved fee)", async () => {
    const db = mkDb();
    await run(db, { subtotal: 50 });
    expect(db.order.update).toHaveBeenCalledTimes(1);
    const db2 = mkDb();
    await run(db2, { invoices: [{ shippingFee: 9 }] });
    expect(db2.order.update).toHaveBeenCalledTimes(1);
  });

  it("an order row that does not carry total/shippingFee (older callers) is still written", async () => {
    const db = mkDb();
    await run(db, { order: { subtotal: "60.00", tax: "0.00" } });
    expect(db.order.update).toHaveBeenCalledTimes(1);
  });

  it("an orphan that is ALREADY cancelled and zeroed is not rewritten; a live billed orphan is cancelled", async () => {
    const db = mkDb();
    const zeroed = {
      id: "z",
      status: "CANCELLED",
      qty: "0",
      subtotal: "0",
      boxes: null,
      pieces: null,
      invoicedQty: "0",
    };
    const live = {
      id: "l",
      status: "PENDING",
      qty: "5",
      subtotal: "50",
      boxes: null,
      pieces: null,
      invoicedQty: "5",
    };
    await run(db, {
      unbilled: new Map([
        ["z", zeroed],
        ["l", live],
      ]),
    });
    expect(db.orderItem.update).toHaveBeenCalledTimes(1);
    expect(db.orderItem.update.mock.calls[0][0].where).toEqual({ id: "l" });
  });
});
