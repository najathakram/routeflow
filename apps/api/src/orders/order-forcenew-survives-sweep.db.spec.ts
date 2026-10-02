/**
 * B985 / SA-631 (WRITTEN, NOT RUN by the author: F2's DB lane runs it and adjusts any fixture field the
 * schema demands; the harness is the backorder-pieces DB spec's, unchanged): a buyer's forceNew order is
 * created with `{ skipAutoMerge: true }` (what BuyerController now passes; pinned in
 * buyer.controller.force-new.spec.ts), so it stays out of BOTH the post-commit and the HOURLY sweep.
 * Real Postgres, the REAL sweeps:
 *  - with an existing PENDING order there are TWO live orders after the create;
 *  - then `mergeAllPendingForCustomer` AND `sweepAllPendingOrders()` (the hourly job's body): still TWO,
 *    the forceNew order is never folded and never hard-deleted (same id, same order number);
 *  - control: two PLAIN orders ARE folded by the same sweep (so the survival is the flag, not a no-op).
 * Named mutation for F2: create the forceNew order WITHOUT the option -> the sweep folds it and deletes the
 * loser -> red.
 *
 * SAFETY: one throwaway `qa-oversell-os-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
 * exactly the rows this run created, in FK order. Run via `npm run local:test:db`.
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
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const KEY = "orders.buyerOversell";

describeDb(
  "B985 a buyer forceNew order survives the post-commit and the hourly sweep, real Postgres",
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
      "order-forcenew-survives-sweep.db.spec.ts",
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

    const plainCreate = (qty: number): Promise<any> =>
      tenantCtx.run(tenantId, () => orders.create({ items: [{ productId, qty }] }, buyer(0)));
    /** What BuyerController.createOrder does for forceNew (B985): the choice is persisted. */
    const forceNewCreate = (qty: number): Promise<any> =>
      tenantCtx.run(tenantId, () =>
        orders.create({ items: [{ productId, qty }] }, buyer(0), { skipAutoMerge: true }),
      );
    const live = () =>
      raw.order.findMany({
        where: { tenantId, customerId: customerIds[0], status: "PENDING" },
        select: { id: true, orderNumber: true, skipAutoMerge: true },
        orderBy: { createdAt: "asc" },
      });
    const postCommitSweep = () =>
      tenantCtx.run(tenantId, () =>
        orders.mergeAllPendingForCustomer(
          customerIds[0],
          { buyerInitiated: true },
          { lockMode: "try" },
        ),
      );
    const hourlySweep = () => tenantCtx.run(tenantId, () => orders.sweepAllPendingOrders());

    it("(a) forceNew with an existing PENDING order: TWO live orders, and the forceNew order persists its choice", async () => {
      const existing = await plainCreate(1);
      const separate = await forceNewCreate(1);
      expect(separate.skipAutoMerge).toBe(true);
      const rows = await live();
      expect(rows.map((r) => r.id).sort()).toEqual([existing.id, separate.id].sort());
      expect(rows.find((r) => r.id === separate.id)!.skipAutoMerge).toBe(true);
    }, 120_000);

    it("(b) the post-commit sweep and then the HOURLY sweep: still TWO, the forceNew order is never folded and never hard-deleted", async () => {
      const existing = await plainCreate(1);
      const separate = await forceNewCreate(1);
      await postCommitSweep();
      await hourlySweep();
      const rows = await live();
      expect(rows).toHaveLength(2);
      const kept = rows.find((r) => r.id === separate.id);
      expect(kept).toBeDefined();
      expect(kept!.orderNumber).toBe(separate.orderNumber); // its order number did not disappear
      expect(rows.find((r) => r.id === existing.id)).toBeDefined();
    }, 120_000);

    it("(control) two PLAIN pending orders ARE folded by the same sweeps, so (b)'s survival is the flag and not a no-op", async () => {
      await plainCreate(1);
      await plainCreate(1);
      await hourlySweep();
      expect(await live()).toHaveLength(1);
    }, 120_000);
  },
);
