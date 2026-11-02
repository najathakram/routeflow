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
    await w?.prisma.stockCountLine.deleteMany({ where: { tenantId: w.tenantId } });
    await w?.prisma.stockCountSession.deleteMany({ where: { tenantId: w.tenantId } });
    await w?.cleanup();
  });

  const introduce = (productId: string, to: number, reading: "box" | "piece" = "box") =>
    w.prisma.$transaction(async (tx) => {
      const data: Record<string, unknown> = { unitsPerBox: to };
      await applyPackIntroduction(tx as any, {
        tenantId: w.tenantId,
        productId,
        from: null,
        to,
        reading,
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

  describe("SA-1093 Rule 5: an open count", () => {
    const refusal = (productId: string, reading: "box" | "piece" = "box") =>
      introduce(productId, 24, reading).then(
        () => "saved",
        (e) => e?.response?.code,
      );
    const counted = async (productId: string) => {
      const session = await w.prisma.stockCountSession.create({
        data: { tenantId: w.tenantId, startedById: w.jwt.sub, name: `count ${productId}` },
      });
      return w.prisma.stockCountLine.create({
        data: {
          tenantId: w.tenantId,
          sessionId: session.id,
          productId,
          mode: "REPLACE",
          countedQty: 40,
          expectedQty: 50,
          countedById: w.jwt.sub,
        },
      });
    };
    const answers = (productId: string) =>
      w.prisma.auditLog.count({
        where: { entityType: "Product", entityId: productId, action: "product.pack_introduced" },
      });

    it("K-1: a line on an open count refuses Boxes, and nothing is written", async () => {
      const p = await w.product("k1", 50);
      await counted(p);
      const rows = (await w.movements(p)).length;

      expect(await refusal(p)).toBe("PRODUCT_IN_OPEN_COUNT");

      expect(await w.stockOf(p)).toBe(50);
      expect((await w.movements(p)).length).toBe(rows);
      expect(await answers(p)).toBe(0);
    });

    it("K-2: the same line, Pieces saves", async () => {
      const p = await w.product("k2", 50);
      await counted(p);

      expect(await refusal(p, "piece")).toBe("saved");
      expect(await w.stockOf(p)).toBe(50);
    });

    it("K-3: the line removed, Boxes saves", async () => {
      const p = await w.product("k3", 50);
      const line = await counted(p);
      await w.prisma.stockCountLine.delete({ where: { id: line.id } });

      expect(await refusal(p)).toBe("saved");
      expect(await w.stockOf(p)).toBe(1200);
    });

    it("K-3: a finished count holds nothing", async () => {
      const p = await w.product("k3done", 50);
      const line = await counted(p);
      await w.prisma.stockCountSession.update({
        where: { id: line.sessionId },
        data: { status: "DISCARDED" },
      });

      expect(await refusal(p)).toBe("saved");
    });
  });

  it("PI-O2: a line with no box split prices the same at N as at blank", () => {
    const line = { qty: 3, unitPrice: 24 };
    expect(computeLineSubtotal({ ...line, unitsPerBox: 10 })).toBe(
      computeLineSubtotal({ ...line, unitsPerBox: null }),
    );
    expect(computeLineSubtotal({ ...line, unitsPerBox: 10 })).toBe(72);
  });
});
