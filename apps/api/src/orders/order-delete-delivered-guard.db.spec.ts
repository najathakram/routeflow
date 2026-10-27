/**
 * Row 585 (SA-814a item 2): `deleteOrder` refuses when any line has `deliveredQty > 0`, real Postgres.
 * Staff may delete an order in any status (owner 2026-08-25), but a delete of a delivered order destroys the
 * invoices and the DeliveryMutation evidence of goods the customer holds. The refusal is a 409
 * ORDER_DELETE_HAS_DELIVERED decided under the Order lock, before any write.
 *
 * RED on master by design (tests only first): master deletes the order, its evidence rows and its lines.
 * Test tenant only. The race test holds the Order row from a side connection and writes `deliveredQty`
 * uncommitted; the delete parks on the lock, and re-reads the committed value under it.
 */
import { Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

describeDb("row 585: deleteOrder refuses an order with delivered units, real Postgres", () => {
  let w: OrderStockWorld;

  beforeAll(async () => {
    w = await buildOrderStockWorld("r585", "order-delete-delivered-guard.db.spec.ts");
  }, 120_000);
  afterAll(async () => {
    await w?.cleanup();
  }, 120_000);

  async function blocked(): Promise<Array<{ pid: number; blockers: number[] }>> {
    const { rows } = await w.pool.query(
      `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    return rows.map((r: any) => ({ pid: Number(r.pid), blockers: r.blockers.map(Number) }));
  }
  async function waitForBlocked(n: number) {
    const deadline = Date.now() + 3000;
    let seen: Awaited<ReturnType<typeof blocked>> = [];
    while (Date.now() < deadline) {
      seen = await blocked();
      if (seen.length === n) return seen;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`race entry not reached: wanted ${n} blocked, saw ${JSON.stringify(seen)}`);
  }

  it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED", "CONFIRMED"])(
    "a %s order with 2 of 5 delivered: 409 ORDER_DELETE_HAS_DELIVERED, order, line, evidence and stock untouched",
    async (status) => {
      const p = await w.product(`r585-${status}`, 10);
      const { order, items } = await w.bookOrder({ status, lines: [{ productId: p, qty: 5 }] });
      await w.prisma.orderItem.update({ where: { id: items[0].id }, data: { deliveredQty: 2 } });
      await w.prisma.deliveryMutation.create({
        data: {
          tenantId: w.tenantId,
          orderId: order.id,
          orderItemId: items[0].id,
          productId: p,
          type: "PARTIAL",
          quantityDelivered: 2,
        } as any,
      });
      const stockBefore = await w.stockOf(p);
      const movementsBefore = (await w.movements(p)).length;

      await expect(w.inTenant(() => w.orders.deleteOrder(order.id, w.jwt))).rejects.toMatchObject({
        status: 409,
        response: { code: "ORDER_DELETE_HAS_DELIVERED" },
      });

      expect(await w.prisma.order.count({ where: { id: order.id } })).toBe(1);
      expect(await w.prisma.orderItem.count({ where: { orderId: order.id } })).toBe(1);
      expect(await w.prisma.deliveryMutation.count({ where: { orderId: order.id } })).toBe(1);
      expect(await w.stockOf(p)).toBe(stockBefore);
      expect((await w.movements(p)).length).toBe(movementsBefore); // no DELETE movement
      await expectLedgerConsistent(w.tenantId, [p]);
    },
    120_000,
  );

  it("bulk delete: the delivered order is reported as an error and kept; the clean one is deleted", async () => {
    const p = await w.product("r585-bulk", 10);
    const delivered = await w.bookOrder({
      status: "PARTIALLY_DELIVERED",
      lines: [{ productId: p, qty: 3 }],
    });
    await w.prisma.orderItem.update({
      where: { id: delivered.items[0].id },
      data: { deliveredQty: 1 },
    });
    const clean = await w.bookOrder({ status: "CONFIRMED", lines: [{ productId: p, qty: 3 }] });

    const res = await w.inTenant<{ deleted: number; errors: string[] }>(() =>
      w.orders.bulkDeleteOrders([delivered.order.id, clean.order.id], w.jwt),
    );

    expect(res.deleted).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain(delivered.order.id);
    expect(await w.prisma.order.count({ where: { id: delivered.order.id } })).toBe(1);
    expect(await w.prisma.order.count({ where: { id: clean.order.id } })).toBe(0);
  }, 120_000);

  it("control: an order with deliveredQty 0 everywhere still deletes and returns its stock", async () => {
    const p = await w.product("r585-control", 10);
    const { order } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId: p, qty: 4 }],
    });
    expect(await w.stockOf(p)).toBe(6);

    await w.inTenant(() => w.orders.deleteOrder(order.id, w.jwt));

    expect(await w.prisma.order.count({ where: { id: order.id } })).toBe(0);
    expect(await w.stockOf(p)).toBe(10);
  }, 120_000);

  it("race: a delivery committed between the delete's first read and its lock still refuses the delete", async () => {
    const p = await w.product("r585-race", 10);
    const { order, items } = await w.bookOrder({
      status: "OUT_FOR_DELIVERY",
      lines: [{ productId: p, qty: 5 }],
    });
    const holder = new Client({ connectionString: requireLocalDatabaseUrl() });
    await holder.connect();
    const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    let held = true;
    const release = async (sql: "COMMIT" | "ROLLBACK") => {
      if (!held) return;
      held = false;
      await holder.query(sql);
    };
    try {
      // A route stop completes: it holds the Order row and writes deliveredQty, uncommitted.
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [order.id]);
      await holder.query(`UPDATE "OrderItem" SET "deliveredQty" = 3 WHERE id = $1`, [items[0].id]);

      // The delete's pre-tx reads see deliveredQty 0, then it parks on the Order lock.
      const del = w
        .inTenant(() => w.orders.deleteOrder(order.id, w.jwt))
        .then(
          (v: unknown) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        );
      const seen = await waitForBlocked(1);
      expect(seen[0].blockers).toEqual([holderPid]);

      await release("COMMIT");
      const out = await del;

      expect(out.ok).toBe(false);
      expect((out as any).e).toMatchObject({
        status: 409,
        response: { code: "ORDER_DELETE_HAS_DELIVERED" },
      });
      expect(await w.prisma.order.count({ where: { id: order.id } })).toBe(1);
      expect(
        Number(
          (await w.prisma.orderItem.findUniqueOrThrow({ where: { id: items[0].id } })).deliveredQty,
        ),
      ).toBe(3);
      expect((await w.movements(p)).filter((m) => m.notes === "DELETE")).toHaveLength(0);
    } finally {
      await release("ROLLBACK").catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  }, 120_000);
});
