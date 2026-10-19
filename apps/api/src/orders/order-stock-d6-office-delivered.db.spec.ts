/**
 * D6 (inventory TEST-PLAN, B692): the office marks an order DELIVERED, then it is cancelled.
 * Stock 10, an order of 10 (counter 0). A manual DELIVERED writes `deliveredQty` = 10 on the line, so the
 * cancel (reached through DELIVERED -> PARTIALLY_DELIVERED, then CANCELLED: a DELIVERED order cannot be
 * cancelled directly) is blocked by the delivered-goods guard and credits 0. The B692 bug was a status change
 * that wrote only `deliveredAt`: `deliveredQty` stayed 0, the cancel went through and credited all 10 back.
 *
 * GREEN on this master (tests only, no fix): delivered-stamp.ts (SA-763r, commit 874724912 "a manual
 * DELIVERED stamps the quantities delivered") already writes deliveredQty on entry to DELIVERED, so the
 * plan's "red on master" and the open registry row B692 are stale. The spec stays as the regression pin; on
 * the old behaviour it fails with deliveredQty 0 (expected 10) and stock 10 after the cancel (expected 0).
 * Linked bug: B692. Real OrdersService + real Postgres; test tenant only.
 */
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

describeDb("D6 / B692: office DELIVERED writes deliveredQty, a later cancel credits 0", () => {
  let w: OrderStockWorld;

  beforeAll(async () => {
    w = await buildOrderStockWorld("d6", "order-stock-d6-office-delivered.db.spec.ts");
  }, 120_000);
  afterAll(async () => {
    await w?.cleanup();
  }, 120_000);

  const status = (id: string, to: string, reason?: string) =>
    w.inTenant(() =>
      w.orders.changeStatus(id, { status: to, ...(reason ? { reason } : {}) }, w.jwt),
    );

  it("B692: marking a CONFIRMED order of 10 DELIVERED writes deliveredQty = 10 on the line", async () => {
    const p = await w.product("d6-qty", 10);
    const { order, items } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId: p, qty: 10 }],
    });
    expect(await w.stockOf(p)).toBe(0); // fixture sanity: the order holds all 10

    await status(order.id, "DELIVERED");

    const line = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect(await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: "DELIVERED",
    });
    expect(Number(line.deliveredQty ?? 0)).toBe(10);
    expect(await w.stockOf(p)).toBe(0); // delivery moves no stock
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 120_000);

  it("B692: after an office DELIVERED, the cancel credits 0 (stock stays 0, not 10)", async () => {
    const p = await w.product("d6-cancel", 10);
    const { order } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId: p, qty: 10 }],
    });
    await status(order.id, "DELIVERED");
    await status(order.id, "PARTIALLY_DELIVERED", "office correction: part of it was refused");

    // Refused (400, delivered goods) is the correct outcome; a cancel that goes through is the bug.
    await status(order.id, "CANCELLED").catch((e: any) => {
      if (!(e?.getStatus?.() >= 400 && e.getStatus() < 500)) throw e;
    });

    expect(await w.stockOf(p)).toBe(0);
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 120_000);
});
