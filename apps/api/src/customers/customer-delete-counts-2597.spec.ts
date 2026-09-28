/**
 * #2597 (SA-516d nit, tier 2): the customer-delete blocker counts aggregate in SQL. On
 * deleteAllCustomers the customer set is the whole tenant, so `countMoneyRecords` /
 * `countDeliveryHistory` must never read every credit note, advance, payment, invoice payment or
 * route-run stop row just to learn whose it is. A row-level `findMany` on any of those tables
 * throws here; the per-customer counts the 409 message prints must come out the same. Red-first.
 */
import { countDeliveryHistory, countMoneyRecords } from "./customer-delete-preflight";

const refuse = (table: string) =>
  jest.fn(() => {
    throw new Error(`row-level read of ${table}`);
  });

function fakeDb(over: Record<string, Record<string, jest.Mock>> = {}) {
  const empty = () => jest.fn().mockResolvedValue([]);
  const base: Record<string, Record<string, jest.Mock>> = {
    creditNote: { groupBy: empty(), findMany: refuse("CreditNote") },
    advancePayment: { groupBy: empty(), findMany: refuse("AdvancePayment") },
    payment: { groupBy: empty(), findMany: refuse("Payment") },
    invoicePayment: { groupBy: empty(), findMany: refuse("InvoicePayment") },
    transaction: { findMany: empty() },
    invoice: { findMany: empty() },
    routeRunStop: { groupBy: empty(), findMany: refuse("RouteRunStop") },
    routeStop: { findMany: empty() },
  };
  for (const [t, m] of Object.entries(over)) base[t] = { ...base[t], ...m };
  return base;
}

describe("customer-delete blocker counts aggregate in SQL (#2597)", () => {
  it("countMoneyRecords: per-customer totals from groupBy + the owners of just the parents with payments", async () => {
    const db = fakeDb({
      creditNote: {
        groupBy: jest.fn().mockResolvedValue([{ customerId: "a", _count: { _all: 2 } }]),
      },
      advancePayment: {
        groupBy: jest.fn().mockResolvedValue([{ customerId: "b", _count: { _all: 1 } }]),
      },
      payment: {
        groupBy: jest.fn().mockResolvedValue([
          { transactionId: "t1", _count: { _all: 3 } },
          { transactionId: "t2", _count: { _all: 1 } },
        ]),
      },
      transaction: {
        findMany: jest.fn().mockResolvedValue([
          { id: "t1", customerId: "a" },
          { id: "t2", customerId: "c" },
        ]),
      },
      invoicePayment: {
        groupBy: jest.fn().mockResolvedValue([{ invoiceId: "i1", _count: { _all: 4 } }]),
      },
      invoice: { findMany: jest.fn().mockResolvedValue([{ id: "i1", customerId: "b" }]) },
    });

    const rows = await countMoneyRecords(db, ["a", "b", "c", "d"]);

    expect(Object.fromEntries(rows.map((r) => [r.customerId, r.count]))).toEqual({
      a: 5, // 2 credit notes + 3 payments on t1
      b: 5, // 1 advance + 4 invoice payments on i1
      c: 1, // 1 payment on t2
    });
    // The parent reads are scoped to exactly the parents that have payments.
    expect(db.transaction.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["t1", "t2"] } },
      select: { id: true, customerId: true },
    });
    expect(db.payment.groupBy.mock.calls[0][0].where).toEqual({
      transaction: { customerId: { in: ["a", "b", "c", "d"] } },
    });
    expect(db.invoicePayment.groupBy.mock.calls[0][0].where).toEqual({
      invoice: { customerId: { in: ["a", "b", "c", "d"] } },
    });
  });

  it("countMoneyRecords: no payments ⇒ no parent read at all", async () => {
    const db = fakeDb();
    await expect(countMoneyRecords(db, ["a"])).resolves.toEqual([]);
    expect(db.transaction.findMany).not.toHaveBeenCalled();
    expect(db.invoice.findMany).not.toHaveBeenCalled();
  });

  it("countDeliveryHistory: owners from a groupBy on the customer's own stops and distinct RouteStop owners with runs", async () => {
    const db = fakeDb({
      routeRunStop: { groupBy: jest.fn().mockResolvedValue([{ customerId: "a" }]) },
      routeStop: { findMany: jest.fn().mockResolvedValue([{ customerId: "b" }]) },
    });

    await expect(countDeliveryHistory(db, ["a", "b", "c"])).resolves.toEqual(["a", "b"]);
    expect(db.routeStop.findMany).toHaveBeenCalledWith({
      where: { customerId: { in: ["a", "b", "c"] }, routeRunStops: { some: {} } },
      select: { customerId: true },
      distinct: ["customerId"],
    });
  });
});
