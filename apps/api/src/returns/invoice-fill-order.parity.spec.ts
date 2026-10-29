import { billedLinesOf } from "./standard-refund-pricing";
import { compareInvoiceFillOrder, loadOrderPool } from "../credit-notes/line-credit-headroom";

/**
 * SA-840 A-2 (F2) parity pin: the refund pricer (`billedLinesOf`) and the order pool's replay (`loadOrderPool`) fill an order's
 * creditable invoices in ONE order, `compareInvoiceFillOrder` (createdAt ascending, then id). Here the id order is NOT the
 * createdAt order, and two invoices tie on createdAt, so a reader that sorts by id (the pool before A-2) disagrees with the
 * pricer. The real-Postgres proof is order-fill-order-sa840.db.spec.ts.
 */
const T1 = new Date("2026-10-01T10:00:00.000Z");
const T2 = new Date("2026-10-02T10:00:00.000Z");
// id order: inv-a, inv-b, inv-c. createdAt order: inv-c (T1), then the T2 tie inv-a, inv-b.
const INVOICES = [
  { id: "inv-a", createdAt: T2 },
  { id: "inv-b", createdAt: T2 },
  { id: "inv-c", createdAt: T1 },
];
const lineOf = (invoiceId: string) => ({
  id: `${invoiceId}-line`,
  orderItemId: null,
  productId: "p",
  subtotal: 100,
  qty: 1,
  boxes: null,
  unitsPerBox: null,
  pieces: null,
  product: { unitsPerBox: null },
});
const EXPECTED = ["inv-c-line", "inv-a-line", "inv-b-line"];

describe("SA-840 A-2 (F2): one fill order for the pricer and the pool", () => {
  it("compareInvoiceFillOrder sorts createdAt ascending, then id (a createdAt tie falls to id)", () => {
    expect([...INVOICES].sort(compareInvoiceFillOrder).map((i) => i.id)).toEqual([
      "inv-c",
      "inv-a",
      "inv-b",
    ]);
    // the id order is the opposite of the fill order on the first pair, which is the whole point of the fixture
    expect([...INVOICES].sort((a, b) => (a.id < b.id ? -1 : 1)).map((i) => i.id)).not.toEqual([
      "inv-c",
      "inv-a",
      "inv-b",
    ]);
    expect(compareInvoiceFillOrder({ id: "x" }, { id: "x" })).toBe(0);
  });

  it("billedLinesOf and loadOrderPool give the same line order, whatever order the invoices arrive in", async () => {
    for (const arrival of [INVOICES, [...INVOICES].reverse()]) {
      const items = arrival.map((i) => ({ ...i, items: [lineOf(i.id)] }));
      const billed = billedLinesOf(
        items.map((i) => ({ ...i, taxAmount: 0, discount: 0 })) as never,
        "p",
      ).lines.map((l) => l.id);
      // the DB hands the pool its invoices in id order (the pre-A-2 order); the pool must still fill in createdAt order
      const byId = [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
      const db: any = {
        invoice: { findMany: jest.fn().mockResolvedValue(byId) },
        creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
        returnItem: { findMany: jest.fn().mockResolvedValue([]) },
        creditNote: { findMany: jest.fn().mockResolvedValue([]) },
        return: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const pool = await loadOrderPool(db, "ord-1");
      expect(billed).toEqual(EXPECTED);
      expect(pool.lines.map((l) => l.id)).toEqual(EXPECTED);
    }
  });
});
