/**
 * #2716c — real-Postgres pins THROUGH OrdersService.updateOrderItems(): the staff price-override
 * rule is ONE rule (`decideStaffOverride`). A below-list edit of an existing line persists DISCOUNTED
 * with originalPrice = LIST; an add-during-edit and a replaceAll changed price classify the same way;
 * a within-half-cent edit of a stored MANUAL-below-list row leaves the row byte-identical (forward
 * only, no re-stamp). The order -> invoice copiers carry priceType + originalPrice verbatim (proven
 * separately by the invoice copier specs; F2 may extend this file with a createFromOrder leg).
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), like buyer-edit-cancelled-line.db.spec.ts.
 * NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it and adjusts any
 * fixture field the schema demands.
 *
 * SAFETY: one throwaway `qa-2716-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
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

describeDb("#2716c — staff price-override rule, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2716-${run}`, "staff-override-rule.db.spec.ts");
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

  /** A loose product at list $6.00 (no tier prices: the customer is tier 1). */
  async function product(tag: string) {
    const p = await raw.product.create({
      data: { name: `${tag} widget ${run}`, unit: "Each", pricePerUnit: "6.00", tenantId },
    });
    productIds.push(p.id);
    return p.id;
  }
  async function order(lines: any[]) {
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: "0.00",
        total: "0.00",
        lineItems: { create: lines.map((l) => ({ tenantId, ...l })) },
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
  const shape = (r: any) => ({
    priceType: r.priceType,
    unitPrice: Number(r.unitPrice),
    originalPrice: r.originalPrice == null ? null : Number(r.originalPrice),
    overrideReason: r.overrideReason,
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
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `2716 ${slug}` } })).id;
    operatorUserId = (
      await raw.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    buyerUserId = (
      await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: buyerUserId, businessName: "2716 co", contactName: "Tester", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: { in: [operatorUserId, buyerUserId] } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("B: a below-list edit of an existing line persists DISCOUNTED with originalPrice = list", async () => {
    const p = await product("below");
    const o = await order([
      { productId: p, qty: 3, unitPrice: "6.00", subtotal: "18.00", priceType: "STANDARD" },
    ]);
    await edit(o.id, {
      replaceAll: false,
      items: [
        { id: o.lineItems[0].id, action: "UPDATE", qty: 3, unitPrice: 4, overrideReason: "deal" },
      ],
    });
    expect(shape((await rows(o.id))[0])).toEqual({
      priceType: "DISCOUNTED",
      unitPrice: 4,
      originalPrice: 6,
      overrideReason: "deal",
    });
  });

  it("B: a within-half-cent edit of a stored MANUAL-below-list row leaves it byte-identical", async () => {
    const p = await product("untouched");
    const o = await order([
      {
        productId: p,
        qty: 3,
        unitPrice: "4.00",
        subtotal: "12.00",
        priceType: "MANUAL",
        originalPrice: "6.00",
        overrideReason: "legacy",
      },
    ]);
    const before = shape((await rows(o.id))[0]);
    await edit(o.id, {
      replaceAll: false,
      items: [{ id: o.lineItems[0].id, action: "UPDATE", qty: 3, unitPrice: 4.003 }],
    });
    expect(shape((await rows(o.id))[0])).toEqual(before);
  });

  it("C: a line added during an edit below list persists DISCOUNTED / list", async () => {
    const p = await product("added");
    const o = await order([]);
    await edit(o.id, {
      replaceAll: false,
      items: [{ productId: p, qty: 2, unitPrice: 4, overrideReason: "deal" }],
    });
    expect(shape((await rows(o.id))[0])).toMatchObject({
      priceType: "DISCOUNTED",
      unitPrice: 4,
      originalPrice: 6,
    });
  });

  it("replaceAll: a changed price below list is DISCOUNTED; an echo of a stored MANUAL row is untouched", async () => {
    const p = await product("replace");
    const q = await product("replace-echo");
    const o = await order([
      { productId: p, qty: 1, unitPrice: "6.00", subtotal: "6.00", priceType: "STANDARD" },
      {
        productId: q,
        qty: 1,
        unitPrice: "4.00",
        subtotal: "4.00",
        priceType: "MANUAL",
        originalPrice: "6.00",
        overrideReason: "legacy",
      },
    ]);
    await edit(o.id, {
      replaceAll: true,
      items: [
        { productId: p, qty: 1, unitPrice: 4, overrideReason: "deal" },
        { productId: q, qty: 1, unitPrice: 4.003 },
      ],
    });
    const byProduct = new Map(
      (await rows(o.id))
        .filter((r) => r.status !== "CANCELLED")
        .map((r) => [r.productId, shape(r)]),
    );
    expect(byProduct.get(p)).toMatchObject({ priceType: "DISCOUNTED", originalPrice: 6 });
    expect(byProduct.get(q)).toEqual({
      priceType: "MANUAL",
      unitPrice: 4,
      originalPrice: 6,
      overrideReason: "legacy",
    });
  });
});
