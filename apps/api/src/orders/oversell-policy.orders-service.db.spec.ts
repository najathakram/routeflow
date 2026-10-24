/**
 * WS9 oversell policy THROUGH the real `OrdersService` against a REAL Postgres (WRITTEN, NOT RUN on
 * the PC; F2's DB lane runs it and adjusts any fixture field the schema demands).
 *
 * oversell-policy.db.spec.ts only calls `decrementStockForSale` with a hand-resolved boolean, so it
 * stays green if `create()` / the edit path ignored the policy. This file closes that gap: it drives
 * `OrdersService.create()` and `OrdersService.updateOrderItems()` (the edit path that calls
 * `settleStockForEdit` with `{ allowOversell }`) with the REAL `PolicyService` (written through
 * `PolicyService.set`) behind the REAL `PolicyOversellReader`, so hard-coding `allowOversell` to true
 * OR false anywhere in create()/the edit path turns a case below red.
 *
 * The reader handed to OrdersService is a thin counting wrapper around the real reader (it delegates;
 * it does not stub), so the staff / driver cases can also assert that no policy read happened.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), exactly as
 * orders-inline-return-create.db.spec.ts / buyer-unit-line-diff.db.spec.ts do; the collaborators
 * create()/updateOrderItems only call for side effects are inert fakes.
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
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const KEY = "orders.buyerOversell";

describeDb(
  "WS9 oversell policy through OrdersService.create() and the edit path, real Postgres",
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
      "oversell-policy.orders-service.db.spec.ts",
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
          ...INVOICE_EDIT_STUBS,
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

    it("(1) policy absent (off): a buyer's order of 6 against stock 5 is refused 409 and nothing is written", async () => {
      // Catches: create() hard-coding allowOversell = true (the order would persist and stock go to -1).
      await expect(createOrder(buyer(0), 6)).rejects.toBeInstanceOf(ConflictException);
      expect(await stockNow()).toBe(5);
      expect(await saleMovements()).toHaveLength(0);
      expect(await orderCount()).toBe(0);
    }, 120_000);

    it("(2) TENANT backorder: the same order succeeds, stock goes to -1, a SALE of 6 is written", async () => {
      // Catches: create() hard-coding allowOversell = false (the policy would be ignored).
      await setPolicy("backorder");
      await createOrder(buyer(0), 6);
      expect(await stockNow()).toBe(-1);
      const sales = await saleMovements();
      expect(sales).toHaveLength(1);
      expect(Math.abs(Number(sales[0].quantity))).toBe(6);
      expect(await orderCount()).toBe(1);
    }, 120_000);

    it("(3a) CUSTOMER scope: TENANT off + c1 backorder -> c1 oversells, c2 is still blocked", async () => {
      // Catches: create() not passing customerId to the resolver (customer layer lost: c1 blocked or
      // c2 allowed), and any hard-coded true/false.
      await setPolicy("off");
      await setPolicy("backorder", { scopeType: "CUSTOMER", scopeId: customerIds[0] });
      await createOrder(buyer(0), 6);
      expect(await stockNow()).toBe(-1);
      expect(await orderCount()).toBe(1);
      // c2 asks for 1 more of a product now at -1: refused, nothing more written.
      await expect(createOrder(buyer(1), 1)).rejects.toBeInstanceOf(ConflictException);
      expect(await stockNow()).toBe(-1);
      expect(await orderCount()).toBe(1);
      expect(await saleMovements()).toHaveLength(1);
    }, 120_000);

    it("(3b) CUSTOMER scope: TENANT backorder + c2 pinned off -> c2 blocked, c1 allowed", async () => {
      // Catches: the same customerId-dropping / hard-coding mistakes, in the reverse direction.
      await setPolicy("backorder");
      await setPolicy("off", { scopeType: "CUSTOMER", scopeId: customerIds[1] });
      await expect(createOrder(buyer(1), 6)).rejects.toBeInstanceOf(ConflictException);
      expect(await stockNow()).toBe(5);
      expect(await orderCount()).toBe(0);
      await createOrder(buyer(0), 6);
      expect(await stockNow()).toBe(-1);
      expect(await orderCount()).toBe(1);
    }, 120_000);

    it("(4) STAFF (OPERATOR) always oversells with the policy off, and never reads the policy", async () => {
      // Catches: create() routing staff through the buyer rule (hard-coding false / reading policy).
      await setPolicy("off");
      await createOrder(operator(), 6, customerIds[0]);
      expect(await stockNow()).toBe(-1);
      expect(await orderCount()).toBe(1);
      expect(readerRead).not.toHaveBeenCalled();
    }, 120_000);

    it("(5a) EDIT path, policy off: a buyer raising 2 -> 7 (needs 5 more, 3 left) is refused 409, stock unchanged", async () => {
      // Catches: updateOrderItems hard-coding allowOversell = true into settleStockForEdit.
      const created = await createOrder(buyer(0), 2);
      expect(await stockNow()).toBe(3);
      const refused: any = await editQty(created.id, 7, buyer(0)).catch((e) => e);
      expect(refused).toBeInstanceOf(ConflictException);
      expect(refused.getStatus()).toBe(409);
      expect(refused.getResponse()).toMatchObject({ code: "INSUFFICIENT_STOCK" });
      expect(await stockNow()).toBe(3);
      const kept = await raw.orderItem.findFirstOrThrow({ where: { orderId: created.id } });
      expect(Number(kept.qty)).toBe(2);
    }, 120_000);

    it("(5b) EDIT path, TENANT backorder: the same edit succeeds and the extra 5 is decremented (stock -2)", async () => {
      // Catches: updateOrderItems hard-coding allowOversell = false (policy ignored on edit).
      await setPolicy("backorder");
      const created = await createOrder(buyer(0), 2);
      expect(await stockNow()).toBe(3);
      await editQty(created.id, 7, buyer(0));
      expect(await stockNow()).toBe(-2);
      const edited = await raw.orderItem.findFirstOrThrow({ where: { orderId: created.id } });
      expect(Number(edited.qty)).toBe(7);
      expect(await orderCount()).toBe(1);
    }, 120_000);

    it("(6) DRIVER never oversells, even with the policy at backorder, and never reads the policy", async () => {
      // Driven end-to-end through the real create() (a driver may create for a customer without a stop
      // link). Catches: create() letting a DRIVER inherit the buyer/staff rule or reading the policy.
      await setPolicy("backorder");
      await expect(createOrder(driver(), 6, customerIds[0])).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await stockNow()).toBe(5);
      expect(await orderCount()).toBe(0);
      expect(readerRead).not.toHaveBeenCalled();
    }, 120_000);
  },
);
