/**
 * SA-946 verdict 3, W-867 (real Postgres, throwaway `qa-*` tenant): an open line with no box split books at the live
 * pack, so once stock is in pieces it credits back exactly what the conversion made of it. A saved line never changes.
 */
import { computeLineSubtotal } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { applyPackIntroduction } from "./pack-intro-apply";

describeDb("SA-946 verdict 3: open lines after a pack is introduced", () => {
  let w: OrderStockWorld;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    w = await buildOrderStockWorld("packintro", "pack-intro-orders.db.spec.ts");
  }, 120_000);

  afterAll(async () => {
    await w?.cleanup();
  });

  const introduce = (productId: string, to: number) =>
    w.prisma.$transaction(async (tx) => {
      const data: Record<string, unknown> = { unitsPerBox: to };
      await applyPackIntroduction(tx as any, {
        tenantId: w.tenantId,
        productId,
        from: null,
        to,
        reading: "box",
        data,
        actorId: null,
      });
      await tx.product.update({ where: { id: productId }, data });
    });

  it("PI-O1: 50 on hand, an open line of 3, the box answer at 10: cancelling credits 30 and stock is 500", async () => {
    const p = await w.product("pi-o1", 50);
    const { order, items } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId: p, qty: 3 }],
    });
    expect(await w.stockOf(p)).toBe(47);

    await introduce(p, 10);
    expect(await w.stockOf(p)).toBe(470);

    const before = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } });
    await w.inTenant(() => w.orders.changeStatus(order.id, { status: "CANCELLED" }, w.jwt));

    expect(await w.stockOf(p)).toBe(500);
    const after = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect([after.qty, after.unitPrice, after.subtotal, after.unitsPerBox]).toEqual([
      before.qty,
      before.unitPrice,
      before.subtotal,
      before.unitsPerBox,
    ]);
  });

  it("PI-O2: a line with no box split prices the same at N as at blank", () => {
    const line = { qty: 3, unitPrice: 24 };
    expect(computeLineSubtotal({ ...line, unitsPerBox: 10 })).toBe(
      computeLineSubtotal({ ...line, unitsPerBox: null }),
    );
    expect(computeLineSubtotal({ ...line, unitsPerBox: 10 })).toBe(72);
  });
});
