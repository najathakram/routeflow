/**
 * SA-606k/n/o: the per-line `backorderPieces` through the REAL `OrdersService` against a REAL
 * Postgres (WRITTEN, NOT RUN by the author: F2's DB lane runs it and adjusts any fixture field the
 * schema demands, same arrangement as oversell-policy.orders-service.db.spec.ts, whose harness this
 * reuses unchanged).
 *
 * Pins (T12-T14 + SA-606o's fold and lowering cases), all with the REAL `PolicyService` behind the
 * REAL reader:
 *   - the figure the locked write returns == the overshoot the SALE movement recorded
 *     (`max(0, -stockAfter)`), and the response lines sum to it (create, and the edit delta);
 *   - two concurrent buyer orders: the figures across both == the real overshoot, no lost update;
 *   - an edit that raises a product, including from an already-negative start, and a lowering edit;
 *   - a fold (`mergeAllPendingForCustomer`) attributes onto the merged order's lines, Σ == overshoot;
 *   - a lowering edit between the write and the re-read (a lost write) OMITS the key.
 * The controller mapping itself is pinned in buyer.controller.backorder.spec.ts.
 *
 * SAFETY: one throwaway `qa-oversell-os-<run>` tenant approved by `assertTestTenant`; `afterAll`
 * deletes exactly the rows this run created, in FK order. Run via `npm run local:test:db`.
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
import { ConflictException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PolicyService } from "../policy/policy.service";
import { PolicyOversellReader } from "./policy-oversell-reader";
import { OrdersService } from "./orders.service";
import { stockWriteOf } from "./order-stock";
import { buyerCreateResponse, withBackorderPieces } from "./backorder-response";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const KEY = "orders.buyerOversell";

describeDb(
  "SA-606o backorderPieces through OrdersService create / merge / edit, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient; // superuser fixture client, deliberately unscoped
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let policies: PolicyService;
    let orders: any;
    let readerRead: jest.Mock;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(
      `qa-oversell-os-${run}`,
      "backorder-pieces.orders-service.db.spec.ts",
    );
    const actor = { id: null, name: "qa-admin", impersonatedBy: null };
    let tenantId = "";
    let operatorUserId = "";
    let driverUserId = "";
    const buyerUserIds: string[] = [];
    const customerIds: string[] = []; // [c1, c2]
    let productId = "";

    const principal = (
      role: "CUSTOMER" | "OPERATOR" | "DRIVER",
      sub: string,
      username: string,
    ): JwtPayload =>
      ({
        sub,
        username,
        role,
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    const buyer = (n: 0 | 1) => principal("CUSTOMER", buyerUserIds[n], `buyer${n + 1}-${run}`);
    const operator = () => principal("OPERATOR", operatorUserId, `op-${run}`);
    const driver = () => principal("DRIVER", driverUserId, `drv-${run}`);

    const setPolicy = (
      value: string,
      scope: { scopeType: "TENANT" | "CUSTOMER"; scopeId?: string } = { scopeType: "TENANT" },
    ) =>
      tenantCtx.run(tenantId, () =>
        policies.set({ tenantId, key: KEY, reason: "qa", actor, value, ...scope }),
      );

    /** A single plain piece-line order create through the REAL OrdersService.create(). */
    const createOrder = (user: JwtPayload, qty: number, customerId?: string) =>
      tenantCtx.run(tenantId, () =>
        orders.create(
          { ...(customerId ? { customerId } : {}), items: [{ productId, qty }] },
          user,
          { skipAutoMerge: true },
        ),
      );

    /** The edit path: PATCH-style per-line qty change through the REAL OrdersService.updateOrderItems(). */
    const editQty = (orderId: string, qty: number, user: JwtPayload) =>
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(orderId, { items: [{ productId, qty }] } as any, user),
      );

    const stockNow = async () =>
      Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
    const orderCount = () => raw.order.count({ where: { tenantId } });
    const saleMovements = () =>
      raw.stockMovement.findMany({
        where: { productId, type: "SALE" },
        orderBy: { createdAt: "asc" },
      });

    /** The write the service returned, and the response lines the buyer controller would put it on. */
    const figures = (order: any) => order.lineItems.map((l: any) => l.backorderPieces);
    const sum = (xs: Array<number | undefined>) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
    const overshootOf = async () => {
      const last = (await saleMovements()).at(-1);
      return last ? Math.max(0, -Number(last.stockAfter)) : 0;
    };

    async function wipeOrders() {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({ where: { productId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      policies = new PolicyService(prisma);
      const realReader = new PolicyOversellReader(policies);
      readerRead = jest.fn((a: { tenantId: string; customerId?: string | null }) =>
        realReader.read(a),
      );
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: {
          emitOrderCreated: jest.fn(),
          emitUrgentOrder: jest.fn(),
          emitOrderStatusChanged: jest.fn(),
          emitLowStock: jest.fn(),
        },
        notifications: {
          sendToCustomer: jest.fn().mockResolvedValue(undefined),
          sendToUser: jest.fn().mockResolvedValue(1),
        },
        messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
          assertLinesSellable: async () => undefined,
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        invoicesService: {
          findOpenOrderDraft: async () => null,
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          reconcileOrderDraftInvoice: async () => undefined,
        },
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        // The REAL PolicyService behind a counting wrapper of the REAL PolicyOversellReader.
        oversellReader: { read: readerRead },
      });

      tenantId = (await raw.tenant.create({ data: { slug, name: `Oversell OS ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `op-${run}@example.test`,
            username: `op-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      driverUserId = (
        await raw.user.create({
          data: {
            email: `drv-${run}@example.test`,
            username: `drv-${run}`,
            role: "DRIVER",
            tenantId,
          },
        })
      ).id;
      for (const n of [1, 2]) {
        // eslint-disable-next-line no-await-in-loop
        const u = await raw.user.create({
          data: {
            email: `buyer${n}-${run}@example.test`,
            username: `buyer${n}-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        });
        buyerUserIds.push(u.id);
        // eslint-disable-next-line no-await-in-loop
        const c = await raw.customer.create({
          data: { userId: u.id, businessName: `Acme ${n}`, contactName: "Tester", tenantId },
        });
        customerIds.push(c.id);
      }
      // A plain piece product (no boxes, no unit ladder).
      productId = (
        await raw.product.create({
          data: {
            name: `Mango ${run}`,
            unit: "each",
            pricePerUnit: "1.00",
            currentStock: 5,
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    beforeEach(async () => {
      await wipeOrders();
      await raw.policyValue.deleteMany({ where: { tenantId } });
      policies.invalidate(tenantId); // the 30 s cache must not carry a prior case's row
      await raw.product.update({ where: { id: productId }, data: { currentStock: 5 } });
      readerRead.mockClear();
    });

    afterAll(async () => {
      try {
        await wipeOrders();
        await raw.auditLog.deleteMany({ where: { tenantId } });
        await raw.policyValue.deleteMany({ where: { tenantId } });
        await raw.product.deleteMany({ where: { tenantId } });
        await raw.customer.deleteMany({ where: { tenantId } });
        await raw.user.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      } finally {
        await _resetLockPoolForTests();
        await prisma?.$disconnect();
        await raw?.$disconnect();
        await pool?.end();
      }
    }, 120_000);

    it("(T12) create: the write's figure == the SALE movement's overshoot, and the response lines sum to it", async () => {
      await setPolicy("backorder");
      const created: any = await createOrder(buyer(0), 8); // stock 5 -> -3
      const write = stockWriteOf(created)!;
      expect(write.backorderByProduct.get(productId)).toBe(3);
      expect(await stockNow()).toBe(-3);
      expect(await overshootOf()).toBe(3);
      const response: any = withBackorderPieces(created, write);
      expect(sum(figures(response))).toBe(3);
    }, 120_000);

    it("(T12b) policy off, a covered order: the figure is 0 on every line (present)", async () => {
      const created: any = await createOrder(buyer(0), 3);
      expect(stockWriteOf(created)!.backorderByProduct.get(productId)).toBe(0);
      expect(figures(withBackorderPieces(created, stockWriteOf(created)))).toEqual([0]);
    }, 120_000);

    it("(T13) two concurrent buyer orders on stock 5 (4 each): the figures across both == the real overshoot, nothing lost", async () => {
      await setPolicy("backorder");
      const [a, b]: any[] = await Promise.all([createOrder(buyer(0), 4), createOrder(buyer(1), 4)]);
      const total =
        sum(figures(withBackorderPieces(a, stockWriteOf(a)))) +
        sum(figures(withBackorderPieces(b, stockWriteOf(b))));
      expect(await stockNow()).toBe(-3);
      expect(total).toBe(3); // the RESPONSE lines across both orders, not just the raw write
      expect(await overshootOf()).toBe(3);
      expect(await orderCount()).toBe(2);
    }, 120_000);

    it("(T14a) edit raising a product: the settle's delta figure == the extra overshoot", async () => {
      await setPolicy("backorder");
      const created: any = await createOrder(buyer(0), 4); // stock 5 -> 1
      const edited: any = await editQty(created.id, 9, buyer(0)); // +5 against 1 -> stock -4
      const write = stockWriteOf(edited)!;
      expect(write.backorderByProduct.get(productId)).toBe(4);
      expect(await stockNow()).toBe(-4);
      expect(await overshootOf()).toBe(4);
      expect(sum(figures(withBackorderPieces(edited, write)))).toBe(4);
    }, 120_000);

    it("(T14b) an already-negative start: the whole raise is backordered; a lowering edit is 0", async () => {
      await setPolicy("backorder");
      await createOrder(buyer(1), 8); // other customer's order takes stock to -3
      const created: any = await createOrder(buyer(0), 2); // all 2 backordered
      expect(stockWriteOf(created)!.backorderByProduct.get(productId)).toBe(2);
      const lowered: any = await editQty(created.id, 1, buyer(0));
      expect(stockWriteOf(lowered)!.backorderByProduct.get(productId) ?? 0).toBe(0);
      expect(figures(withBackorderPieces(lowered, stockWriteOf(lowered)))).toEqual([0]);
    }, 120_000);

    it("(single) a plain checkout with NO other pending order: the sweep returns the bare created row and the figure still lands", async () => {
      await setPolicy("backorder");
      const created: any = await createOrder(buyer(0), 8); // stock 5 -> -3, overshoot 3
      const swept: any = await tenantCtx.run(tenantId, () =>
        orders.mergeAllPendingForCustomer(customerIds[0], { buyerInitiated: true }),
      );
      expect(swept?.id).toBe(created.id); // the real shape: that one order, read with lineItems only
      const response: any = buyerCreateResponse(created, swept);
      expect(response.id).toBe(created.id);
      expect(sum(figures(response))).toBe(3);
      expect(await overshootOf()).toBe(3);
    }, 120_000);

    it("(fold) a second order folded into the first: the fold HAPPENED, and the merged lines sum to the overshoot", async () => {
      await setPolicy("backorder");
      const first: any = await tenantCtx.run(tenantId, () =>
        orders.create({ items: [{ productId, qty: 4 }] }, buyer(0)),
      ); // stock 5 -> 1, no overshoot
      const second: any = await tenantCtx.run(tenantId, () =>
        orders.create({ items: [{ productId, qty: 4 }] }, buyer(0)),
      ); // 1 - 4 -> -3, overshoot 3
      const swept: any = await tenantCtx.run(tenantId, () =>
        orders.mergeAllPendingForCustomer(customerIds[0], { buyerInitiated: true }),
      );
      // The fold actually happened (a no-op sweep or a merge-at-create would also give sum 3):
      // exactly ONE live PENDING order remains, it holds BOTH orders' 8 pieces, and the order that
      // was folded away is gone or cancelled. With skipAutoMerge:true on both creates this is red.
      const live = await raw.order.findMany({
        where: { tenantId, customerId: customerIds[0], status: "PENDING" },
        include: { lineItems: true },
      });
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(swept.id);
      expect(live[0].lineItems.reduce((n, l) => n + Number(l.qty), 0)).toBe(8);
      const loserId = swept.id === first.id ? second.id : first.id;
      const loser = await raw.order.findUnique({ where: { id: loserId } });
      expect(loser === null || loser.status === "CANCELLED").toBe(true);
      const response: any = buyerCreateResponse(second, swept);
      expect(sum(figures(response))).toBe(3);
      expect(await overshootOf()).toBe(3);
    }, 120_000);

    it("(lost write) a lowering edit between the write and the re-read omits the key on the whole order", async () => {
      await setPolicy("backorder");
      const created: any = await createOrder(buyer(0), 8); // overshoot 3
      const write = stockWriteOf(created)!;
      await editQty(created.id, 1, buyer(0)); // a concurrent edit lowers the lines below the overshoot
      const reread: any = await tenantCtx.run(tenantId, () => orders.findOne(created.id, buyer(0)));
      const response: any = withBackorderPieces(reread, write);
      expect(figures(response).every((f: unknown) => f === undefined)).toBe(true);
    }, 120_000);
  },
);
