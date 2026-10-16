/**
 * B284 guards around the fix, real Postgres: a CANCELLED order was already credited by its cancel, so deleting
 * it must NOT credit again; the bulk delete runs the same release per order. Test tenant only.
 */
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

describeDb("O6b / B284: delete releases stock exactly once, real Postgres", () => {
  let w: OrderStockWorld;

  beforeAll(async () => {
    w = await buildOrderStockWorld("o6b", "order-stock-o6b-delete-guards.db.spec.ts");
  }, 120_000);
  afterAll(async () => {
    await w?.cleanup();
  }, 120_000);

  it("deleting a CANCELLED order (already credited by its cancel) leaves stock at 10 and adds no movement", async () => {
    const p = await w.product("o6b-cancelled", 10);
    const { order } = await w.bookOrder({
      status: "CANCELLED",
      lines: [{ productId: p, qty: 3 }],
      cancelled: true,
    });
    expect(await w.stockOf(p)).toBe(10);
    const before = (await w.movements(p)).length;

    await w.inTenant(() => w.orders.deleteOrder(order.id, w.jwt));

    expect(await w.stockOf(p)).toBe(10);
    expect((await w.movements(p)).length).toBe(before);
    expect(await w.prisma.order.count({ where: { id: order.id } })).toBe(0);
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 120_000);

  it("bulk delete of a PENDING and a CONFIRMED order of 3 each puts both back: stock 10, two DELETE movements", async () => {
    const p = await w.product("o6b-bulk", 10);
    const a = await w.bookOrder({ status: "PENDING", lines: [{ productId: p, qty: 3 }] });
    const b = await w.bookOrder({ status: "CONFIRMED", lines: [{ productId: p, qty: 3 }] });
    expect(await w.stockOf(p)).toBe(4);

    const res = await w.inTenant(() => w.orders.bulkDeleteOrders([a.order.id, b.order.id], w.jwt));

    expect(res).toEqual({ deleted: 2, errors: [] });
    expect(await w.stockOf(p)).toBe(10);
    const back = (await w.movements(p)).filter((m) => m.notes === "DELETE");
    expect(back.map((m) => [m.type, Number(m.quantity)])).toEqual([
      ["SALE", 3],
      ["SALE", 3],
    ]);
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 120_000);
});
