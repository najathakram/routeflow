/**
 * #2565 — real-Postgres pins THROUGH OrdersService.updateOrderItems(): a NON-OWNER buyer's diff on
 * another customer's order is a bare 403 BEFORE any side effect — the linked SENT invoice stays
 * SENT and the order's lines stay byte-identical. Red on master: a strike-off-only diff skipped
 * every conditional pre-tx owner check, so `revertLinkedInvoicesForOrderEdit` (which commits on its
 * own connection) ran first and the 403 came only inside the transaction.
 *
 * The revert is stubbed with the real one's observable effect (the order's SENT invoice → DRAFT), so
 * the pin sees whether it ran. Control: the OWNER's same diff does reach it.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as buyer-edit-cancelled-line.db.spec.ts
 * does. NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it.
 *
 * SAFETY: one throwaway `qa-2565-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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

describeDb("#2565 — a non-owner buyer's edit reverts nothing before its 403, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2565-${run}`, "buyer-owner-first.db.spec.ts");
  let tenantId = "";
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];

  const buyerOf = (userId: string): JwtPayload =>
    ({
      sub: userId,
      username: `buyer-${userId.slice(0, 6)}`,
      role: "CUSTOMER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  async function buyer(tag: string) {
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(user.id);
    const customer = await raw.customer.create({
      data: { userId: user.id, businessName: `${tag} co`, contactName: "Tester", tenantId },
    });
    customerIds.push(customer.id);
    return { userId: user.id, customerId: customer.id };
  }

  /** A PENDING order of `customerId` with one 6-piece Box line, and its SENT invoice. */
  async function orderWithSentInvoice(customerId: string, tag: string) {
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
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: "10.00",
        total: "10.00",
        lineItems: {
          create: [
            {
              tenantId,
              productId: p.id,
              qty: 6,
              boxes: 1,
              pieces: 0,
              unitsPerBox: 6,
              unitPrice: "10.00",
              subtotal: "10.00",
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    const inv = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-2565-${tag}-${run}`,
        customerId,
        orderId: o.id,
        status: "SENT",
        subtotal: "10.00",
        total: "10.00",
        tenantId,
      },
    });
    invoiceIds.push(inv.id);
    return { order: o, invoiceId: inv.id };
  }

  const rows = (orderId: string) =>
    raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const invoiceStatus = async (id: string) =>
    (await raw.invoice.findUniqueOrThrow({ where: { id } })).status;
  const strikeOff = (lineId: string) => ({
    replaceAll: false,
    items: [{ id: lineId, action: "CANCEL" }],
  });

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
        // The real revert's observable effect: this order's SENT invoice drops to DRAFT.
        revertLinkedInvoicesForOrderEdit: async (orderId: string) => {
          await raw.invoice.updateMany({
            where: { orderId, status: "SENT" },
            data: { status: "DRAFT" },
          });
        },
        resyncOrderInvoicesForEdit: async () => [],
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `2565 ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("a non-owner buyer's strike-off diff: bare 403, the SENT invoice stays SENT, lines identical", async () => {
    const owner = await buyer("owner");
    const intruder = await buyer("intruder");
    const { order, invoiceId } = await orderWithSentInvoice(owner.customerId, "victim");
    const before = await rows(order.id);
    await expect(
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(
          order.id,
          strikeOff(order.lineItems[0].id),
          buyerOf(intruder.userId),
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await invoiceStatus(invoiceId)).toBe("SENT");
    expect(await rows(order.id)).toEqual(before);
  });

  it("control: the OWNER's same diff passes the owner check and reaches the revert", async () => {
    const owner = await buyer("owner2");
    const { order, invoiceId } = await orderWithSentInvoice(owner.customerId, "own");
    await tenantCtx
      .run(tenantId, () =>
        orders.updateOrderItems(order.id, strikeOff(order.lineItems[0].id), buyerOf(owner.userId)),
      )
      .catch(() => undefined); // later steps are not this pin's concern
    expect(await invoiceStatus(invoiceId)).toBe("DRAFT");
  });
});
