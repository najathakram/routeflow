/**
 * W-1187 PR-1b (SA ruling, D3/D4/D11) - real-Postgres pins THROUGH OrdersService: the order owns its line order, so every
 * writer that adds, merges or replaces lines leaves the lines in the order the staff arranged, with dense unique positions.
 *
 *   R1-R3  a merge appends the losers' lines after the winner's, in the order the carts were started
 *   R4-R5  a staff diff-add lands LAST (after merged and after legacy lines), never on top
 *   R9     the order detail read has a total order (position, createdAt, id)
 *   BR1-4  a buyer's quantity edit never reorders (staff's unlisted lines stay put, a CANCELLED row keeps its slot)
 *   BR5    a driver's list edit keeps the prior slots
 *   W-1189 a buyer cannot edit a REFUSED order
 *   G-a    a same-product fold keeps the winner line's slot
 *
 * Each row fails on master on the wrong value stated in its comment.
 *
 * SAFETY: one throwaway `qa-w1187b-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly its rows.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buildDbOrdersService } from "../common/testing/orders-service-db-harness";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ORDER_LINE_ORDER_BY } from "./line-position";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "W-1187 PR-1b: an order's lines keep the order they were arranged in (real Postgres)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-w1187b-${run}`, "order-line-positions.db.spec.ts");
    let tenantId = "";
    let staffUserId = "";
    let buyerUserId = "";
    let driverUserId = "";
    let driverId = "";
    let routeId = "";
    let customerId = "";
    const userIds: string[] = [];
    const orderIds: string[] = [];
    const productIds: string[] = [];
    const label = new Map<string, string>(); // productId -> short label
    let stopSeq = 0;
    let clock = Date.parse("2026-11-01T12:00:00Z");
    const tick = () => new Date((clock += 60_000));

    const principal = (role: "CUSTOMER" | "OPERATOR" | "DRIVER", sub: string): JwtPayload =>
      ({
        sub,
        username: `${role.toLowerCase()}-${run}`,
        role,
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    const staff = () => principal("OPERATOR", staffUserId);
    const buyer = () => principal("CUSTOMER", buyerUserId);

    const made = new Map<string, string>(); // a product is unique per tenant by name: one per label
    async function product(tag: string) {
      const known = made.get(tag);
      if (known) return known;
      const p = await raw.product.create({
        data: {
          name: `${tag} ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          currentStock: "100000",
          tenantId,
        },
      });
      productIds.push(p.id);
      label.set(p.id, tag);
      made.set(tag, p.id);
      return p.id;
    }

    /** A line spec: a catalog line (`p`) or an unlisted one (`u`); `at` is its stored position (null = none). */
    type L = { p?: string; u?: string; at: number | null; status?: string; qty?: number };
    async function order(
      lines: L[],
      over: { createdAt?: Date; updatedAt?: Date; status?: string; routeRunId?: string } = {},
    ) {
      const createdAt = over.createdAt ?? tick();
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: (over.status ?? "PENDING") as any,
          subtotal: "0.00",
          total: "0.00",
          createdAt,
          updatedAt: over.updatedAt ?? createdAt,
          ...(over.routeRunId ? { routeRunId: over.routeRunId } : {}),
          lineItems: {
            create: lines.map((l) => ({
              tenantId,
              productId: l.p ?? null,
              name: l.u ?? null,
              qty: l.qty ?? 1,
              unitPrice: "1.00",
              subtotal: String((l.qty ?? 1).toFixed(2)),
              priceType: l.u ? "MANUAL" : "STANDARD",
              status: (l.status ?? "PENDING") as any,
              position: l.at,
              createdAt,
            })),
          },
        },
        include: { lineItems: true },
      });
      orderIds.push(o.id);
      return o;
    }

    const lineId = (o: { lineItems: any[] }, key: string) =>
      o.lineItems.find((l) => (l.productId ? label.get(l.productId) : l.name) === key)!
        .id as string;

    /** The order's lines in the read order: [label, position]. */
    const read = async (orderId: string) =>
      (await raw.orderItem.findMany({ where: { orderId }, orderBy: ORDER_LINE_ORDER_BY })).map(
        (l) => [(l.productId ? label.get(l.productId) : l.name) as string, l.position] as const,
      );
    const names = async (orderId: string) => (await read(orderId)).map(([n]) => n);
    const positions = async (orderId: string) => (await read(orderId)).map(([, p]) => p);

    const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
    const merge = () => inTenant(() => orders.mergeAllPendingForCustomer(customerId, {}));
    const staffEdit = (orderId: string, items: any[]) =>
      inTenant(() => orders.updateOrderItems(orderId, { items, replaceAll: false }, staff()));
    const buyerEdit = (orderId: string, items: any[], who: JwtPayload = buyer()) =>
      inTenant(() =>
        orders.updateOrderItems(orderId, { items, namesLines: true }, who, { buyerLineIds: true }),
      );

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      orders = buildDbOrdersService(prisma, tenantCtx);
      tenantId = (await raw.tenant.create({ data: { slug, name: `w1187b ${slug}` } })).id;
      const mkUser = async (tag: string, role: "OPERATOR" | "CUSTOMER" | "DRIVER") => {
        const u = await raw.user.create({
          data: { email: `${tag}-${run}@example.test`, username: `${tag}-${run}`, role, tenantId },
        });
        userIds.push(u.id);
        return u.id;
      };
      staffUserId = await mkUser("s", "OPERATOR");
      buyerUserId = await mkUser("b", "CUSTOMER");
      driverUserId = await mkUser("d", "DRIVER");
      driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
      customerId = (
        await raw.customer.create({
          data: {
            userId: buyerUserId,
            businessName: "Acme Retail",
            contactName: "Tester",
            tenantId,
          },
        })
      ).id;
      routeId = (await raw.route.create({ data: { tenantId, name: `w1187b route ${run}` } as any }))
        .id;
    }, 120_000);

    afterAll(async () => {
      await raw.routeRunStop.deleteMany({ where: { routeRun: { route: { tenantId } } } });
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.routeRun.deleteMany({ where: { route: { tenantId } } });
      await raw.routeStop.deleteMany({ where: { route: { tenantId } } });
      await raw.route.deleteMany({ where: { tenantId } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.driver.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    /** Merges park nothing between tests: every order of the customer from a previous test is removed first. */
    beforeEach(async () => {
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.orderIdempotencyKey.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      orderIds.length = 0;
    });

    describe("merge", () => {
      it("R1: a loser's lines follow the winner's, in the loser's own order", async () => {
        const [w1, l1, l2] = [await product("W1"), await product("L1"), await product("L2")];
        const loser = await order([
          { p: l2, at: 1 },
          { p: l1, at: 0 },
        ]);
        const winner = await order([{ p: w1, at: 0 }], { updatedAt: tick() });
        await merge();
        // master: [W1:0, then L1 and L2 with position NULL, in id order]
        expect(await read(winner.id)).toEqual([
          ["W1", 0],
          ["L1", 1],
          ["L2", 2],
        ]);
        expect(await raw.order.count({ where: { id: loser.id } })).toBe(0);
      });

      it("R2: an unlisted loser line keeps its place between two catalog lines", async () => {
        const [w1, l1, l2] = [await product("W1"), await product("L1"), await product("L2")];
        await order([
          { p: l1, at: 0 },
          { u: "Loose item", at: 1 },
          { p: l2, at: 2 },
        ]);
        const winner = await order([{ p: w1, at: 0 }], { updatedAt: tick() });
        await merge();
        // master: unlisted lines are written after both catalog creates, all positions NULL
        expect(await names(winner.id)).toEqual(["W1", "L1", "Loose item", "L2"]);
        expect(await positions(winner.id)).toEqual([0, 1, 2, 3]);
      });

      it("R3: two losers append in the order the carts were started, not the order they were touched", async () => {
        const [w1, a1, b1] = [await product("W1"), await product("A1"), await product("B1")];
        const older = new Date("2026-10-01T09:00:00Z");
        const newer = new Date("2026-10-01T10:00:00Z");
        // B was started later but touched EARLIER than A: updatedAt order is the reverse of createdAt order
        await order([{ p: a1, at: 0 }], { createdAt: older, updatedAt: tick() });
        await order([{ p: b1, at: 0 }], { createdAt: newer, updatedAt: tick() });
        const winner = await order([{ p: w1, at: 0 }], { updatedAt: tick() });
        await merge();
        expect(await read(winner.id)).toEqual([
          ["W1", 0],
          ["A1", 1],
          ["B1", 2],
        ]);
      });

      it("G-a: a same-product fold keeps the winner line's slot and adds no line", async () => {
        const [w1, shared] = [await product("W1"), await product("S1")];
        await order([{ p: shared, at: 0, qty: 2 }]);
        const winner = await order(
          [
            { p: w1, at: 0 },
            { p: shared, at: 1, qty: 3 },
          ],
          { updatedAt: tick() },
        );
        await merge();
        expect(await read(winner.id)).toEqual([
          ["W1", 0],
          ["S1", 1],
        ]);
        const folded = await raw.orderItem.findFirstOrThrow({
          where: { orderId: winner.id, productId: shared },
        });
        expect(Number(folded.qty)).toBe(5);
      });
    });

    describe("diff-add", () => {
      it("R4: a product added after a merge lands after the merged lines", async () => {
        const [w1, l1, l2, n1] = [
          await product("W1"),
          await product("L1"),
          await product("L2"),
          await product("N1"),
        ];
        await order([
          { p: l1, at: 0 },
          { p: l2, at: 1 },
        ]);
        const winner = await order([{ p: w1, at: 0 }], { updatedAt: tick() });
        await merge();
        await staffEdit(winner.id, [{ productId: n1, qty: 1 }]);
        // master: [W1, N1 (position 1), L1, L2 (NULL, last)]
        expect(await read(winner.id)).toEqual([
          ["W1", 0],
          ["L1", 1],
          ["L2", 2],
          ["N1", 3],
        ]);
      });

      it("R5: a legacy order (no positions) keeps its lines in today's order and the new line goes last", async () => {
        const [a, b, c, n1] = [
          await product("A"),
          await product("B"),
          await product("C"),
          await product("N1"),
        ];
        const created = tick();
        const legacy = await raw.order.create({
          data: {
            customerId,
            tenantId,
            status: "PENDING",
            subtotal: "0.00",
            total: "0.00",
            lineItems: {
              create: [
                {
                  tenantId,
                  productId: b,
                  qty: 1,
                  unitPrice: "1.00",
                  subtotal: "1.00",
                  createdAt: new Date(+created + 2),
                },
                {
                  tenantId,
                  productId: a,
                  qty: 1,
                  unitPrice: "1.00",
                  subtotal: "1.00",
                  createdAt: new Date(+created + 1),
                },
                {
                  tenantId,
                  productId: c,
                  qty: 1,
                  unitPrice: "1.00",
                  subtotal: "1.00",
                  createdAt: new Date(+created + 3),
                },
              ],
            },
          },
        });
        orderIds.push(legacy.id);
        await staffEdit(legacy.id, [{ productId: n1, qty: 1 }]);
        // master: N1 takes position 0 (max of nothing is -1) and shows FIRST
        expect(await read(legacy.id)).toEqual([
          ["A", 0],
          ["B", 1],
          ["C", 2],
          ["N1", 3],
        ]);
      });

      it("an unlisted line added by staff lands last too, and a qty-only edit writes no position", async () => {
        const [a, b] = [await product("A"), await product("B")];
        const o = await order([
          { p: a, at: 0 },
          { p: b, at: 1 },
        ]);
        await staffEdit(o.id, [{ name: "Loose", qty: 1, unitPrice: 2 }]);
        expect(await names(o.id)).toEqual(["A", "B", "Loose"]);
        const before = await raw.orderItem.findMany({ where: { orderId: o.id } });
        await staffEdit(o.id, [{ id: lineId(o, "A"), qty: 4 }]);
        const after = await raw.orderItem.findMany({ where: { orderId: o.id } });
        expect(after.map((l) => [l.id, l.position]).sort()).toEqual(
          before.map((l) => [l.id, l.position]).sort(),
        );
      });
    });

    describe("read", () => {
      it("R9: the order detail lists lines with no position in a fixed order (position, createdAt, id)", async () => {
        const ps = await Promise.all(["A", "B", "C", "D", "E", "F"].map(product));
        const o = await order(ps.map((p) => ({ p, at: null })));
        const detail: any = await inTenant(() => orders.findOne(o.id, staff()));
        const ids: string[] = detail.lineItems.map((l: any) => l.id);
        // master: no id tiebreak, so equal-createdAt lines come back in heap (insertion) order, not id order
        expect(ids).toEqual([...ids].sort());
      });
    });

    describe("a buyer's edit never reorders", () => {
      /** [U (staff's unlisted line), A, B] at 0..2, PENDING. */
      async function arranged() {
        const [a, b, n] = [await product("A"), await product("B"), await product("N")];
        const o = await order([
          { u: "Staff add-on", at: 0 },
          { p: a, at: 1 },
          { p: b, at: 2 },
        ]);
        return { o, a, b, n };
      }

      it("BR1: changing a quantity leaves the staff's unlisted line where it is", async () => {
        const { o, a, b } = await arranged();
        await buyerEdit(o.id, [
          { productId: a, qty: 1, orderItemId: lineId(o, "A") },
          { productId: b, qty: 3, orderItemId: lineId(o, "B") },
        ]);
        // master (B51 re-stamp): [A, B, Staff add-on]
        expect(await names(o.id)).toEqual(["Staff add-on", "A", "B"]);
        expect(await positions(o.id)).toEqual([0, 1, 2]);
      });

      it("BR2: listing the lines in another order does not reorder them", async () => {
        const { o, a, b } = await arranged();
        await buyerEdit(o.id, [
          { productId: b, qty: 3, orderItemId: lineId(o, "B") },
          { productId: a, qty: 1, orderItemId: lineId(o, "A") },
        ]);
        // master: [B, A, Staff add-on] (the payload order wins)
        expect(await names(o.id)).toEqual(["Staff add-on", "A", "B"]);
      });

      it("BR3: a product the buyer adds goes after every line", async () => {
        const { o, a, b, n } = await arranged();
        await buyerEdit(o.id, [
          { productId: a, qty: 1, orderItemId: lineId(o, "A") },
          { productId: b, qty: 1, orderItemId: lineId(o, "B") },
          { productId: n, qty: 2 },
        ]);
        // master: [A, B, N, Staff add-on]
        expect(await names(o.id)).toEqual(["Staff add-on", "A", "B", "N"]);
        expect(await positions(o.id)).toEqual([0, 1, 2, 3]);
      });

      it("BR4: a CANCELLED row keeps its slot and no two lines share a position", async () => {
        const [a, c, b] = [await product("A"), await product("C"), await product("B")];
        const o = await order([
          { p: a, at: 0 },
          { p: c, at: 1, status: "CANCELLED" },
          { p: b, at: 2 },
        ]);
        await buyerEdit(o.id, [
          { productId: a, qty: 5, orderItemId: lineId(o, "A") },
          { productId: b, qty: 1, orderItemId: lineId(o, "B") },
        ]);
        // master: A and B are re-stamped 0 and 1 while the CANCELLED row keeps 1: two lines at position 1
        expect(await read(o.id)).toEqual([
          ["A", 0],
          ["C", 1],
          ["B", 2],
        ]);
      });

      it("a removed line leaves a gap that is closed: the others stay in order and dense", async () => {
        const { o, a, b } = await arranged();
        await buyerEdit(o.id, [{ productId: b, qty: 1, orderItemId: lineId(o, "B") }]);
        void a;
        expect(await read(o.id)).toEqual([
          ["Staff add-on", 0],
          ["B", 1],
        ]);
      });
    });

    describe("a driver's list edit", () => {
      it("BR5: keeps the prior slots instead of the payload order", async () => {
        const [a, b, c] = [await product("A"), await product("B"), await product("C")];
        stopSeq += 1;
        const routeStop = await raw.routeStop.create({
          data: { tenantId, routeId, stopNumber: stopSeq, customerId } as any,
        });
        const rr = await raw.routeRun.create({
          data: {
            tenantId,
            routeId,
            scheduledDate: new Date("2026-11-02T00:00:00.000Z"),
            status: "IN_PROGRESS" as any,
            driverId,
          },
        });
        const stop = await raw.routeRunStop.create({
          data: {
            tenantId,
            routeRunId: rr.id,
            routeStopId: routeStop.id,
            stopNumber: 1,
            status: "PENDING" as any,
          } as any,
        });
        const o = await raw.order.create({
          data: {
            customerId,
            tenantId,
            status: "CONFIRMED",
            subtotal: "0.00",
            total: "0.00",
            routeRunId: rr.id,
            routeRunStopId: stop.id,
            lineItems: {
              create: [a, b, c].map((p, i) => ({
                tenantId,
                productId: p,
                qty: 2,
                unitPrice: "1.00",
                subtotal: "2.00",
                position: i,
              })),
            },
          },
        });
        orderIds.push(o.id);
        await inTenant(() =>
          orders.updateOrderItems(
            o.id,
            {
              items: [
                { productId: c, qty: 3 },
                { productId: a, qty: 2 },
                { productId: b, qty: 2 },
              ],
            },
            principal("DRIVER", driverUserId),
          ),
        );
        // master: [C, A, B] (the driver's array order is stamped)
        expect(await read(o.id)).toEqual([
          ["A", 0],
          ["B", 1],
          ["C", 2],
        ]);
      });
    });

    describe("W-1189", () => {
      it("a buyer cannot edit a REFUSED order (403, nothing written)", async () => {
        const [a] = [await product("A")];
        const o = await order([{ p: a, at: 0, qty: 1 }], { status: "REFUSED" });
        await expect(
          buyerEdit(o.id, [{ productId: a, qty: 9, orderItemId: lineId(o, "A") }]),
        ).rejects.toMatchObject({ status: 403 });
        const line = await raw.orderItem.findFirstOrThrow({ where: { orderId: o.id } });
        expect(Number(line.qty)).toBe(1);
      });
    });
  },
);
