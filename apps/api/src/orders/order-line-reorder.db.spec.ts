/**
 * W-1187 PR-1b (SA ruling D5, D11) - real-Postgres pins for `OrdersService.reorderLines` (the staff and buyer line-order
 * routes share it): the caller arranges an order's lines, the order keeps that order, and nothing else moves.
 *
 *   G-e   the CAS token and the id set (stale, missing, extra, foreign, duplicate: 409, nothing written)
 *   G-e2  only the changed rows are written; the order's updatedAt moves; one audit row; an unchanged order writes nothing
 *   G-f   a CANCELLED order is refused; a busy order answers a retryable 409 instead of queueing
 *   BG-a  another customer of the tenant: a bare 403, on any status
 *   BG-b  another tenant: 404; a soft-deleted customer: 403
 *   BG-c  a buyer's edit window: closed statuses 403 (REFUSED names why), CONFIRMED allowed
 *   BG-d  any non-buyer reorders through the staff path; the audit row names the role
 *   BR6   the staff order read says who rearranged the lines
 *
 * These are guards on a new endpoint (there is nothing on master to fail), not red-first rows.
 *
 * SAFETY: throwaway `qa-w1187r-<run>` tenants approved by `assertTestTenant`; `afterAll` deletes exactly its rows.
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
import { LINES_REORDERED_ACTION } from "./order-line-order";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("W-1187 PR-1b: reordering an order's lines (real Postgres)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-w1187r-${run}`, "order-line-reorder.db.spec.ts");
  const otherSlug = assertTestTenant(`qa-w1187r-o-${run}`, "order-line-reorder.db.spec.ts");
  let tenantId = "";
  let otherTenantId = "";
  const users: Record<string, string> = {};
  const customers: Record<string, string> = {};
  const userIds: string[] = [];
  const productIds: string[] = [];
  const label = new Map<string, string>();
  const made = new Map<string, string>();
  let clock = Date.parse("2026-11-01T12:00:00Z");
  const tick = () => new Date((clock += 60_000));

  const principal = (role: "CUSTOMER" | "OPERATOR" | "DRIVER", sub: string, tid = tenantId) =>
    ({
      sub,
      username: `${role.toLowerCase()}-${run}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: tid,
      tenantSlug: tid === tenantId ? slug : otherSlug,
    }) as JwtPayload;
  const staff = () => principal("OPERATOR", users.staff);
  const buyer = (who = "buyer") => principal("CUSTOMER", users[who]);

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

  type L = { p: string; at: number | null; status?: string };
  async function order(lines: L[], over: { status?: string; owner?: string } = {}) {
    const createdAt = tick();
    return raw.order.create({
      data: {
        customerId: customers[over.owner ?? "buyer"],
        tenantId,
        status: (over.status ?? "PENDING") as any,
        subtotal: "0.00",
        total: "0.00",
        createdAt,
        updatedAt: createdAt,
        lineItems: {
          create: lines.map((l) => ({
            tenantId,
            productId: l.p,
            qty: 1,
            unitPrice: "1.00",
            subtotal: "1.00",
            priceType: "STANDARD",
            status: (l.status ?? "PENDING") as any,
            position: l.at,
            createdAt,
          })),
        },
      },
      include: { lineItems: true },
    });
  }

  const lineId = (o: { lineItems: any[] }, tag: string) =>
    o.lineItems.find((l) => label.get(l.productId) === tag)!.id as string;
  const read = async (orderId: string) =>
    (await raw.orderItem.findMany({ where: { orderId }, orderBy: ORDER_LINE_ORDER_BY })).map(
      (l) => [label.get(l.productId!) as string, l.position] as const,
    );
  const tokenOf = async (orderId: string) =>
    (await raw.order.findUniqueOrThrow({ where: { id: orderId } })).updatedAt.toISOString();
  const inTenant = <T>(fn: () => Promise<T>, tid = tenantId) => tenantCtx.run(tid, fn);
  const reorder = async (
    o: { id: string },
    ids: string[],
    who: JwtPayload = staff(),
    over: { expectedUpdatedAt?: string } = {},
  ) =>
    inTenant(
      async () =>
        orders.reorderLines(
          o.id,
          { expectedUpdatedAt: over.expectedUpdatedAt ?? (await tokenOf(o.id)), lineIds: ids },
          who,
        ),
      who.tenantId ?? undefined,
    );
  const audits = (orderId: string) =>
    raw.auditLog.findMany({ where: { entityId: orderId, action: LINES_REORDERED_ACTION } });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    orders = buildDbOrdersService(prisma, tenantCtx);
    tenantId = (await raw.tenant.create({ data: { slug, name: `w1187r ${slug}` } })).id;
    otherTenantId = (
      await raw.tenant.create({ data: { slug: otherSlug, name: `w1187r ${otherSlug}` } })
    ).id;
    const mkUser = async (tag: string, role: "OPERATOR" | "CUSTOMER" | "DRIVER") => {
      const u = await raw.user.create({
        data: { email: `${tag}-${run}@example.test`, username: `${tag}-${run}`, role, tenantId },
      });
      userIds.push(u.id);
      users[tag] = u.id;
    };
    await mkUser("staff", "OPERATOR");
    await mkUser("driver", "DRIVER");
    for (const tag of ["buyer", "rival", "gone"]) await mkUser(tag, "CUSTOMER");
    for (const tag of ["buyer", "rival", "gone"]) {
      customers[tag] = (
        await raw.customer.create({
          data: {
            userId: users[tag],
            businessName: `Acme ${tag}`,
            contactName: "Tester",
            tenantId,
            ...(tag === "gone" ? { deletedAt: new Date() } : {}),
          },
        })
      ).id;
    }
  }, 120_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  beforeEach(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
  });

  async function abc(over: { status?: string; owner?: string } = {}) {
    const [a, b, c] = [await product("A"), await product("B"), await product("C")];
    return order(
      [
        { p: a, at: 0 },
        { p: b, at: 1 },
        { p: c, at: 2 },
      ],
      over,
    );
  }

  describe("the token and the id set", () => {
    it("G-e: staff arranges the lines; the order keeps it and the answer carries the next token", async () => {
      const o = await abc();
      const res = await reorder(o, [lineId(o, "C"), lineId(o, "A"), lineId(o, "B")]);
      expect(await read(o.id)).toEqual([
        ["C", 0],
        ["A", 1],
        ["B", 2],
      ]);
      expect(res.updatedAt).toBe(await tokenOf(o.id));
      expect(res.linesRearranged.by).toBe("STAFF");
      expect(res.lineIds).toEqual([lineId(o, "C"), lineId(o, "A"), lineId(o, "B")]);
    });

    it("R-sort: sort name puts C, B, A lines in A to Z on real rows, CANCELLED kept in the set", async () => {
      const [a, b, c] = [await product("A"), await product("B"), await product("C")];
      const o = await order([
        { p: c, at: 0 },
        { p: b, at: 1, status: "CANCELLED" },
        { p: a, at: 2 },
      ]);
      const res = await inTenant(async () =>
        orders.reorderLines(
          o.id,
          { expectedUpdatedAt: await tokenOf(o.id), sort: "name" },
          staff(),
        ),
      );
      expect(await read(o.id)).toEqual([
        ["A", 0],
        ["B", 1],
        ["C", 2],
      ]);
      expect(res.lineIds).toHaveLength(3);
    });

    it("G-e: a stale token is a 409 and nothing is written", async () => {
      const o = await abc();
      await expect(
        reorder(o, [lineId(o, "C"), lineId(o, "A"), lineId(o, "B")], staff(), {
          expectedUpdatedAt: new Date(Date.parse(await tokenOf(o.id)) - 5000).toISOString(),
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await read(o.id)).toEqual([
        ["A", 0],
        ["B", 1],
        ["C", 2],
      ]);
      expect(await audits(o.id)).toHaveLength(0);
    });

    it("G-e: a missing, extra, foreign or CANCELLED-omitting id list is the same 409", async () => {
      const o = await abc();
      const other = await order([{ p: await product("A"), at: 0 }]);
      const [a, b, c] = [lineId(o, "A"), lineId(o, "B"), lineId(o, "C")];
      for (const ids of [
        [a, b], // missing
        [a, b, c, lineId(other, "A")], // extra and foreign
        [a, b, lineId(other, "A")], // foreign in place of one
        [a, b, "00000000-0000-4000-8000-000000000000"], // unknown
      ]) {
        await expect(reorder(o, ids)).rejects.toMatchObject({ status: 409 });
      }
      expect(await read(o.id)).toEqual([
        ["A", 0],
        ["B", 1],
        ["C", 2],
      ]);
    });

    it("G-e: a CANCELLED line is part of the id set and keeps its place in the order", async () => {
      const [a, b, c] = [await product("A"), await product("B"), await product("C")];
      const o = await order([
        { p: a, at: 0 },
        { p: b, at: 1, status: "CANCELLED" },
        { p: c, at: 2 },
      ]);
      await expect(reorder(o, [lineId(o, "C"), lineId(o, "A")])).rejects.toMatchObject({
        status: 409,
      });
      await reorder(o, [lineId(o, "C"), lineId(o, "B"), lineId(o, "A")]);
      expect(await read(o.id)).toEqual([
        ["C", 0],
        ["B", 1],
        ["A", 2],
      ]);
    });

    it("G-e2: NULL and duplicate stored positions are densified by the reorder", async () => {
      const [a, b, c] = [await product("A"), await product("B"), await product("C")];
      const o = await order([
        { p: a, at: null },
        { p: b, at: 5 },
        { p: c, at: 5 },
      ]);
      await reorder(o, [lineId(o, "B"), lineId(o, "C"), lineId(o, "A")]);
      expect(await read(o.id)).toEqual([
        ["B", 0],
        ["C", 1],
        ["A", 2],
      ]);
    });

    it("G-e2: only the changed rows are written; an unchanged order writes no bump and no audit row", async () => {
      const o = await abc();
      const before = await tokenOf(o.id);
      const ids = [lineId(o, "A"), lineId(o, "B"), lineId(o, "C")];
      const same = await reorder(o, ids);
      expect(await tokenOf(o.id)).toBe(before);
      expect(same.updatedAt).toBe(before);
      expect(await audits(o.id)).toHaveLength(0);

      const stamp = async () =>
        Object.fromEntries(
          (await raw.orderItem.findMany({ where: { orderId: o.id } })).map((l) => [
            label.get(l.productId!),
            l.updatedAt.toISOString(),
          ]),
        );
      const touched = await stamp();
      await reorder(o, [ids[1], ids[0], ids[2]]); // swap A and B only
      const after = await stamp();
      expect(after.C).toBe(touched.C);
      expect(after.A).not.toBe(touched.A);
      expect(await tokenOf(o.id)).not.toBe(before);
      const rows = await audits(o.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: users.staff, entityType: "Order", tenantId });
      expect(rows[0].meta).toMatchObject({
        role: "OPERATOR",
        before: ids,
        after: [ids[1], ids[0], ids[2]],
      });
    });

    it("G-e2: a second reorder with the new token works; the old token is then a 409", async () => {
      const o = await abc();
      const ids = [lineId(o, "A"), lineId(o, "B"), lineId(o, "C")];
      const old = await tokenOf(o.id);
      const first = await reorder(o, [ids[2], ids[1], ids[0]]);
      await reorder(o, ids, staff(), { expectedUpdatedAt: first.updatedAt });
      await expect(
        reorder(o, [ids[2], ids[1], ids[0]], staff(), { expectedUpdatedAt: old }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("status and locking", () => {
    it("G-f: a CANCELLED order is refused for everyone (400)", async () => {
      const o = await abc({ status: "CANCELLED" });
      await expect(
        reorder(o, [lineId(o, "C"), lineId(o, "A"), lineId(o, "B")]),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        reorder(o, [lineId(o, "C"), lineId(o, "A"), lineId(o, "B")], buyer()),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("G-f: an order another transaction holds answers a retryable 409 at once", async () => {
      const o = await abc();
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [o.id]);
        const started = Date.now();
        await expect(
          reorder(o, [lineId(o, "C"), lineId(o, "A"), lineId(o, "B")]),
        ).rejects.toMatchObject({ status: 409 });
        expect(Date.now() - started).toBeLessThan(5000);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect(await read(o.id)).toEqual([
        ["A", 0],
        ["B", 1],
        ["C", 2],
      ]);
    });

    it("G-f: a merge and a reorder on the same order leave dense, unique positions", async () => {
      const [a, b, c, d] = [
        await product("A"),
        await product("B"),
        await product("C"),
        await product("D"),
      ];
      const winner = await order([
        { p: a, at: 0 },
        { p: b, at: 1 },
      ]);
      await order([
        { p: c, at: 0 },
        { p: d, at: 1 },
      ]);
      const results = await Promise.allSettled([
        inTenant(() => orders.mergeAllPendingForCustomer(customers.buyer, {})),
        reorder(winner, [lineId(winner, "B"), lineId(winner, "A")]),
      ]);
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      const survivor = await raw.order.findFirst({
        where: { customerId: customers.buyer },
        orderBy: { createdAt: "asc" },
      });
      const pos = (await read(survivor!.id)).map(([, p]) => p);
      expect(pos).toEqual(pos.map((_, i) => i));
    });
  });

  describe("the buyer", () => {
    it("BG-a: another customer of the same tenant gets a bare 403, whatever the status", async () => {
      for (const status of ["PENDING", "OUT_FOR_DELIVERY"]) {
        const o = await abc({ status });
        const err: any = await reorder(
          o,
          [lineId(o, "C"), lineId(o, "A"), lineId(o, "B")],
          buyer("rival"),
        ).catch((e) => e);
        expect(err.status).toBe(403);
        expect(String(err.message)).toBe("Forbidden");
        expect(await read(o.id)).toEqual([
          ["A", 0],
          ["B", 1],
          ["C", 2],
        ]);
        await raw.orderItem.deleteMany({ where: { orderId: o.id } });
        await raw.order.delete({ where: { id: o.id } });
      }
    });

    it("BG-b: another tenant's context finds no such order (404); a soft-deleted customer is 403", async () => {
      const o = await abc();
      await expect(
        inTenant(
          () =>
            orders.reorderLines(
              o.id,
              {
                expectedUpdatedAt: o.updatedAt.toISOString(),
                lineIds: o.lineItems.map((l: any) => l.id),
              },
              principal("OPERATOR", users.staff, otherTenantId),
            ),
          otherTenantId,
        ),
      ).rejects.toMatchObject({ status: 404 });

      const mine = await abc({ owner: "gone" });
      await expect(
        reorder(mine, [lineId(mine, "C"), lineId(mine, "A"), lineId(mine, "B")], buyer("gone")),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("BG-c: the owner reorders while the window is open", async () => {
      const o = await abc({ status: "CONFIRMED" });
      const res = await reorder(o, [lineId(o, "B"), lineId(o, "C"), lineId(o, "A")], buyer());
      expect(await read(o.id)).toEqual([
        ["B", 0],
        ["C", 1],
        ["A", 2],
      ]);
      expect(res.linesRearranged.by).toBe("CUSTOMER");
    });

    it("BG-c: a closed window is a 403 with the closed sentence; REFUSED says why", async () => {
      for (const status of ["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED", "REFUSED"]) {
        const o = await abc({ status });
        const err: any = await reorder(
          o,
          [lineId(o, "C"), lineId(o, "A"), lineId(o, "B")],
          buyer(),
        ).catch((e) => e);
        expect(err.status).toBe(403);
        expect(String(err.message).length).toBeGreaterThan(10);
        if (status === "REFUSED") expect(String(err.message)).toMatch(/refused/i);
        expect(await read(o.id)).toEqual([
          ["A", 0],
          ["B", 1],
          ["C", 2],
        ]);
        expect(await audits(o.id)).toHaveLength(0);
        await raw.orderItem.deleteMany({ where: { orderId: o.id } });
        await raw.order.delete({ where: { id: o.id } });
      }
    });

    it("BG-e: the buyer's audit row names the role and the buyer's user id", async () => {
      const o = await abc();
      await reorder(o, [lineId(o, "B"), lineId(o, "A"), lineId(o, "C")], buyer());
      const [row] = await audits(o.id);
      expect(row.userId).toBe(users.buyer);
      expect((row.meta as any).role).toBe("CUSTOMER");
    });
  });

  describe("staff paths", () => {
    it("BG-d: the service treats any non-buyer as staff (the route's Roles gate keeps drivers out) and the audit row names the role", async () => {
      const o = await abc();
      const res = await reorder(
        o,
        [lineId(o, "C"), lineId(o, "B"), lineId(o, "A")],
        principal("DRIVER", users.driver),
      );
      expect(res.linesRearranged.by).toBe("STAFF");
      const [row] = await audits(o.id);
      expect((row.meta as any).role).toBe("DRIVER");
    });

    it("BR6: the staff order read says the customer rearranged the lines; the buyer's read does not", async () => {
      const o = await abc();
      await reorder(o, [lineId(o, "B"), lineId(o, "A"), lineId(o, "C")], buyer());
      const staffView: any = await inTenant(() => orders.findOne(o.id, staff()));
      expect(staffView.linesRearranged).toMatchObject({ by: "CUSTOMER" });
      expect(typeof staffView.linesRearranged.at).toBe("string");
      expect(staffView.lineItems.map((l: any) => label.get(l.productId))).toEqual(["B", "A", "C"]);
      const buyerView: any = await inTenant(() => orders.findOne(o.id, buyer()));
      expect(buyerView.linesRearranged).toBeUndefined();
    });
  });
});
