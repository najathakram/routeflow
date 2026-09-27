/**
 * #2563 (SA-507b) — real-Postgres pins THROUGH OrdersService.updateOrderItems(): a staff per-line diff
 * CANCEL or DELETE naming ANOTHER order's line id is a 404 and writes nothing — the foreign line and
 * its order stay byte-identical, and the edited order's own lines are untouched (the 404 is thrown
 * inside the edit's transaction). Red on master: the removal wrote by bare id, so the foreign line
 * was cancelled/deleted while only the URL order was recomputed. A removal of this order's own
 * line still works (control).
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as buyer-edit-cancelled-line.db.spec.ts
 * does. NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it.
 *
 * SAFETY: one throwaway `qa-2563-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
 * exactly the rows this run created.
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
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "SA-474 (#2443) — a held Case line is never re-denominated to the pack, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2563-${run}`, "order-line-removal.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let buyerUserId = "";
    let customerId = "";
    const productIds: string[] = [];
    const orderIds: string[] = [];

    const operator = (): JwtPayload =>
      ({
        sub: operatorUserId,
        username: `op-${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    /** A 6-piece Box product at $10 a box (stocked), with a Case of 12 at $18 on its ladder. */
    async function product(tag: string) {
      const p = await raw.product.create({
        data: {
          name: `${tag} cola ${run}`,
          unit: "Box",
          pricePerUnit: "10.00",
          unitsPerBox: 6,
          currentStock: "10000",
          tenantId,
        },
      });
      productIds.push(p.id);
      await raw.productUnit.create({
        data: { tenantId, productId: p.id, label: "Case", factorToBase: 12, price: "18.00" },
      });
      return p.id;
    }

    async function order(line: any) {
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "0.00",
          total: "0.00",
          lineItems: { create: [{ tenantId, ...line }] },
        },
        include: { lineItems: true },
      });
      orderIds.push(o.id);
      return o;
    }

    const edit = (orderId: string, dto: any) =>
      tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, operator()));
    const rows = (orderId: string) =>
      raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    const stock = async (id: string) =>
      Number((await raw.product.findUniqueOrThrow({ where: { id } })).currentStock);

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
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
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          reconcileOrderDraftInvoice: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `2563 ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `o-${run}@example.test`,
            username: `o-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      buyerUserId = (
        await raw.user.create({
          data: {
            email: `b-${run}@example.test`,
            username: `b-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        })
      ).id;
      customerId = (
        await raw.customer.create({
          data: { userId: buyerUserId, businessName: "2563 co", contactName: "Tester", tenantId },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.productUnit.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: { in: [operatorUserId, buyerUserId] } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    /** A plain 6-piece Box line: 1 box at $10. */
    const packLine = (productId: string) => ({
      productId,
      qty: 6,
      boxes: 1,
      pieces: 0,
      unitsPerBox: 6,
      unitPrice: "10.00",
      subtotal: "10.00",
    });

    it.each(["CANCEL", "DELETE"])(
      "a %s naming another order's line is a 404; both orders are byte-identical",
      async (action) => {
        const cola = await product(`foreign-${action}`);
        const mine = await order(packLine(cola));
        const other = await order(packLine(cola));
        const [mineBefore, otherBefore] = [await rows(mine.id), await rows(other.id)];
        const stockBefore = await stock(cola);
        await expect(
          edit(mine.id, { replaceAll: false, items: [{ id: other.lineItems[0].id, action }] }),
        ).rejects.toMatchObject({ status: 404 });
        expect(await rows(other.id)).toEqual(otherBefore);
        expect(await rows(mine.id)).toEqual(mineBefore);
        expect(await stock(cola)).toBe(stockBefore);
      },
    );

    it("control: a CANCEL / DELETE of this order's own line still works", async () => {
      const cola = await product("own");
      const o = await order(packLine(cola));
      await edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, action: "CANCEL" }] });
      expect((await rows(o.id))[0].status).toBe("CANCELLED");
      const o2 = await order(packLine(cola));
      await edit(o2.id, {
        replaceAll: false,
        items: [{ id: o2.lineItems[0].id, action: "DELETE" }],
      });
      expect(await rows(o2.id)).toEqual([]);
    });
  },
);
