/**
 * Row 380 (buyer half of row 372) — real-Postgres pins for a BUYER (CUSTOMER) caller of OrdersService:
 *  (1) the buyer order read carries `revisionNumber` after the customer allowlist;
 *  (2) a buyer edit holding a stale `expectedRevisionNumber` is 409 ORDER_REVISION_STALE and the order is untouched;
 *  (3) the buyer edit holding the current number goes through.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as buyer-edit-cancelled-line.db.spec.ts does.
 * SAFETY: one throwaway `qa-380-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes what it made.
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
import { latestEditRevisionNumber } from "./order-revisions";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { toCustomerOrder } from "../common/staff-only-fields";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("row 380: the buyer order edit revision guard, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-380-${run}`, "orders.buyer-revision-guard.db.spec.ts");
  let tenantId = "";
  let customerUserId = "";
  let customerId = "";
  const productIds: string[] = [];
  const orderIds: string[] = [];

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

  /** A PENDING order holding one plain pack line of `productId`. */
  async function order(productId: string) {
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: "20.00",
        total: "20.00",
        lineItems: {
          create: [
            {
              tenantId,
              productId,
              qty: 2,
              unitPrice: "10.00",
              subtotal: "20.00",
              status: "PENDING",
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    return o;
  }

  const buyer = (): JwtPayload =>
    ({
      sub: customerUserId,
      username: "",
      role: "CUSTOMER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
      type: "BUYER",
    }) as unknown as JwtPayload;
  const edit = (orderId: string, dto: any) =>
    tenantCtx.run(tenantId, () =>
      orders.updateOrderItems(orderId, dto, buyer(), { buyerLineIds: true }),
    );
  const read = (orderId: string) =>
    tenantCtx.run(tenantId, async () =>
      toCustomerOrder(await orders.findOne(orderId, buyer())),
    ) as Promise<{ revisionNumber?: number }>;
  const rows = (orderId: string) =>
    raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const latest = () => (orderId: string) =>
    tenantCtx.run(tenantId, () => latestEditRevisionNumber(prisma.forTenant() as any, orderId));

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
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `380 ${slug}` } })).id;
    customerUserId = (
      await raw.user.create({
        data: { email: `c-${run}@example.test`, username: `c-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: customerUserId, businessName: "380 co", contactName: "Tester", tenantId },
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
    await raw.user.deleteMany({ where: { id: { in: [customerUserId] } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("the buyer read carries the revision, a stale buyer edit is 409 and writes nothing, the current number edits", async () => {
    const cola = await product("rev");
    const o = await order(cola);
    const lineId = o.lineItems[0].id;
    const r0 = await latest()(o.id);
    expect((await read(o.id)).revisionNumber).toBe(r0);

    // another tab's edit lands first: the revision moves on
    await edit(o.id, { items: [{ orderItemId: lineId, productId: cola, qty: 3 }] });
    const r1 = await latest()(o.id);
    expect(r1).toBeGreaterThan(r0);
    expect((await read(o.id)).revisionNumber).toBe(r1);

    // this tab still holds r0
    await expect(
      edit(o.id, {
        items: [{ orderItemId: lineId, productId: cola, qty: 9 }],
        expectedRevisionNumber: r0,
      }),
    ).rejects.toMatchObject({ response: { code: "ORDER_REVISION_STALE" } });
    const after = await rows(o.id);
    expect(Number(after[0].qty)).toBe(3); // the first edit stands, the stale one wrote nothing
    expect(await latest()(o.id)).toBe(r1);

    // the current number goes through (a buyer edit re-creates its lines, so name the line as the read shows it)
    await edit(o.id, {
      items: [{ orderItemId: after[0].id, productId: cola, qty: 4 }],
      expectedRevisionNumber: r1,
    });
    expect(Number((await rows(o.id))[0].qty)).toBe(4);
  });
});
