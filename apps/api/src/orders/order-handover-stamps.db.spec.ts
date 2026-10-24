/**
 * Row 342 — real-Postgres proof (the house rule: a Prisma select / include change needs an EXECUTED query, a mock
 * accepts a relation that does not exist) that the staff order detail and the staff invoice detail return the
 * hand-over stamp: the order's `registerKey` and its cashier (`soldBy`, the username only) plus the built
 * `handedOverBy` display name, so the web can show "Handed over at register main by Pat". A buyer's read of the
 * same order and invoice carries none of it.
 *
 * NOT RUN by the lane that wrote it (no Postgres there): the DB lane runs it (`npm run local:test:db`, test
 * tenants only, collected only by jest.db.config.js). One throwaway `qa-row342-<run>` tenant; `afterAll` deletes
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
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { OrdersService } from "./orders.service";
import type { InvoicesService } from "../invoices/invoices.service";

// The module is mocked above (OrdersService imports it); the invoice read under test is the REAL class.
const RealInvoicesService: new (...a: unknown[]) => InvoicesService = jest.requireActual(
  "../invoices/invoices.service",
).InvoicesService;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "row 342 — the hand-over stamp on the staff order + invoice detail, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: OrdersService;
    let invoices: InvoicesService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-row342-${run}`, "order-handover-stamps.db.spec.ts");
    let tenantId = "";
    let staffId = "";
    let buyerUserId = "";
    let customerId = "";
    const staffName = `pat-${run}`;
    const orderIds: string[] = [];
    const invoiceIds: string[] = [];

    const as = (role: string, sub: string): JwtPayload =>
      ({
        sub,
        username: `u-${run}`,
        role,
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    async function pickupOrder(stamp: { registerKey: string | null; soldById: string | null }) {
      const n = orderIds.length + 1;
      const order = await raw.order.create({
        data: {
          customerId,
          tenantId,
          fulfillPath: "PICKUP",
          status: "DELIVERED",
          orderNumber: `R342${run}-${n}`,
          total: 10,
          registerKey: stamp.registerKey,
          soldById: stamp.soldById,
        },
      });
      orderIds.push(order.id);
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-R342-${run}-${n}`,
          customerId,
          orderId: order.id,
          tenantId,
          status: "SENT",
          subtotal: 10,
          total: 10,
        },
      });
      invoiceIds.push(invoice.id);
      return { orderId: order.id, invoiceId: invoice.id };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      orders = Object.assign(Object.create(OrdersService.prototype), { prisma });
      invoices = Object.assign(Object.create(RealInvoicesService.prototype), {
        prisma,
        systemConfig: { get: async () => null },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `Row342 ${slug}` } })).id;
      await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
      staffId = (
        await raw.user.create({
          data: {
            email: `s-${run}@example.test`,
            username: staffName,
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
          data: {
            userId: buyerUserId,
            businessName: `Acme Test ${run}`,
            contactName: "Tester",
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: { in: [staffId, buyerUserId] } } });
      await raw.tenantConfig.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("staff order detail: the stamped register, the cashier's username only, and the built name", async () => {
      const { orderId } = await pickupOrder({ registerKey: "reg-2", soldById: staffId });
      const out = (await tenantCtx.run(tenantId, () =>
        orders.findOne(orderId, as("OPERATOR", staffId)),
      )) as unknown as Record<string, any>;
      expect(out.registerKey).toBe("reg-2");
      expect(out.soldBy).toEqual({ username: staffName }); // never the email or another user column
      expect(out.handedOverBy).toBe(staffName);
    });

    it("staff invoice detail: the order stub carries the same stamp", async () => {
      const { invoiceId } = await pickupOrder({ registerKey: "reg-2", soldById: staffId });
      const out = (await tenantCtx.run(tenantId, () =>
        invoices.findOne(invoiceId, as("OPERATOR", staffId)),
      )) as unknown as { order: Record<string, any> };
      expect(out.order).toMatchObject({
        orderNumber: expect.stringContaining("R342"),
        fulfillPath: "PICKUP",
        registerKey: "reg-2",
        soldBy: { username: staffName },
        handedOverBy: staffName,
      });
    });

    it("an unstamped (older) order reads null, never a guessed register or cashier", async () => {
      const { orderId, invoiceId } = await pickupOrder({ registerKey: null, soldById: null });
      const order = (await tenantCtx.run(tenantId, () =>
        orders.findOne(orderId, as("OPERATOR", staffId)),
      )) as unknown as Record<string, any>;
      expect(order.registerKey).toBeNull();
      expect(order.soldBy).toBeNull();
      expect(order.handedOverBy).toBeNull();
      const inv = (await tenantCtx.run(tenantId, () =>
        invoices.findOne(invoiceId, as("OPERATOR", staffId)),
      )) as unknown as { order: Record<string, any> };
      expect(inv.order).toMatchObject({ registerKey: null, soldBy: null, handedOverBy: null });
    });

    it("the buyer's read of the same order and invoice carries no register and no cashier", async () => {
      const { orderId, invoiceId } = await pickupOrder({ registerKey: "reg-2", soldById: staffId });
      const buyer = as("CUSTOMER", buyerUserId);
      const order = (await tenantCtx.run(tenantId, () =>
        orders.findOne(orderId, buyer),
      )) as unknown as Record<string, any>;
      for (const key of ["registerKey", "soldById", "soldBy", "handedOverBy"]) {
        expect(order).not.toHaveProperty(key);
      }
      // the invoice must be non-DRAFT to be visible to the buyer (SENT above)
      const inv = (await tenantCtx.run(tenantId, () =>
        invoices.findOne(invoiceId, buyer),
      )) as unknown as Record<string, any>;
      expect(inv).not.toHaveProperty("order");
      expect(JSON.stringify(inv)).not.toContain(staffName);
    });
  },
);
