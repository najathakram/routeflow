/**
 * Row 497 (SA ruling, option B) + row 496 — real-Postgres pins THROUGH OrdersService.updateOrderItems(): a buyer's
 * FULL-LIST replace of PACK lines keeps the stored price, type, original price, reason and stamp of an UNCHANGED
 * override line (DISCOUNTED / MANUAL, or SPECIAL with a stored reason), recomputes the subtotal from the kept
 * price (boxed proration), re-prices a PLAIN tier line at the current tier (SA-507b), and prices a new line or a
 * changed product fresh. A staff edit with a formula-led overrideReason is refused 400 with zero writes.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), as buyer-edit-cancelled-line.db.spec.ts does.
 * NOT RUN by the lane that wrote it (DB specs are the prover's).
 *
 * SAFETY: one throwaway `qa-497-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly the rows
 * this run created.
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
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("row 497 — a buyer's full-list replace keeps unchanged overrides, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-497-${run}`, "buyer-replace-keeps-override.db.spec.ts");
  let tenantId = "";
  let buyerUserId = "";
  let staffUserId = "";
  let customerId = "";
  const productIds: string[] = [];
  const orderIds: string[] = [];

  const principal = (role: "CUSTOMER" | "OPERATOR", sub: string): JwtPayload =>
    ({
      sub,
      username: `${role.toLowerCase()}-${run}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  /** A boxed product: 12 pieces a box, $12.00 a box (tier 1). */
  async function product(tag: string) {
    const p = await raw.product.create({
      data: {
        name: `${tag} cola ${run}`,
        unit: "Box",
        pricePerUnit: "12.00",
        unitsPerBox: 12,
        currentStock: "10000",
        tenantId,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  /** One stored pack line: 1 box + 6 pieces (18 pieces), shaped as an OrderItem create. */
  const packLine = (productId: string, over: Record<string, unknown> = {}) => ({
    productId,
    qty: 18,
    boxes: 1,
    pieces: 6,
    unitsPerBox: 12,
    unitPrice: "12.00",
    subtotal: "18.00",
    priceType: "STANDARD",
    ...over,
  });
  const OVERRIDE = {
    unitPrice: "8.00",
    subtotal: "12.00",
    priceType: "DISCOUNTED",
    originalPrice: "12.00",
    overrideReason: "damaged cartons",
    overriddenBy: "staff-user-497",
  };

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

  const buyerEdit = (orderId: string, items: any[]) =>
    tenantCtx.run(tenantId, () =>
      orders.updateOrderItems(
        orderId,
        { items, namesLines: true },
        principal("CUSTOMER", buyerUserId),
        {
          buyerLineIds: true,
        },
      ),
    );
  const rows = (orderId: string) =>
    raw.orderItem.findMany({
      where: { orderId },
      orderBy: { position: "asc" },
    });
  const shape = (r: any) => ({
    productId: r.productId,
    qty: Number(r.qty),
    unitPrice: Number(r.unitPrice),
    subtotal: Number(r.subtotal),
    priceType: r.priceType,
    originalPrice: r.originalPrice == null ? null : Number(r.originalPrice),
    overrideReason: r.overrideReason ?? null,
    overriddenBy: r.overriddenBy ?? null,
  });
  const KEPT = {
    unitPrice: 8,
    priceType: "DISCOUNTED",
    originalPrice: 12,
    overrideReason: "damaged cartons",
    overriddenBy: "staff-user-497",
  };

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
    tenantId = (await raw.tenant.create({ data: { slug, name: `497 ${slug}` } })).id;
    buyerUserId = (
      await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    staffUserId = (
      await raw.user.create({
        data: { email: `s-${run}@example.test`, username: `s-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: buyerUserId, businessName: "497 co", contactName: "Tester", tenantId },
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
    await raw.user.deleteMany({ where: { id: { in: [buyerUserId, staffUserId] } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("R1: an overridden line re-sent unchanged keeps price, type, original price, reason and stamp", async () => {
    const p = await product("r1");
    const o = await order([packLine(p, OVERRIDE)]);
    await buyerEdit(o.id, [{ productId: p, qty: 18, orderItemId: o.lineItems[0].id }]);
    const live = await rows(o.id);
    expect(live).toHaveLength(1);
    // hand: 1 box x $8 + 6 pieces x ($8 / 12) = $12.00
    expect(shape(live[0])).toMatchObject({ ...KEPT, subtotal: 12 });
  });

  it("R2: the same line with a changed qty keeps the price and recomputes the subtotal", async () => {
    const p = await product("r2");
    const o = await order([packLine(p, OVERRIDE)]);
    await buyerEdit(o.id, [{ productId: p, qty: 30, orderItemId: o.lineItems[0].id }]);
    const live = await rows(o.id);
    // hand: 30 pieces = 2 boxes + 6 pieces: 2 x $8 + 6 x ($8 / 12) = $20.00 (the tier price would give $30.00)
    expect(shape(live[0])).toMatchObject({ ...KEPT, qty: 30, subtotal: 20 });
    expect(live[0].boxes).toBe(2);
    expect(live[0].pieces).toBe(6);
  });

  it("R3: a MANUAL override and a SPECIAL line with a stored reason are kept", async () => {
    const a = await product("r3a");
    const b = await product("r3b");
    const o = await order([
      packLine(a, {
        unitPrice: "15.00",
        subtotal: "22.50",
        priceType: "MANUAL",
        originalPrice: "12.00",
        overrideReason: "upsell",
        overriddenBy: "staff-user-497",
        position: 0,
      }),
      packLine(b, {
        unitPrice: "9.00",
        subtotal: "13.50",
        priceType: "SPECIAL",
        originalPrice: "12.00",
        overrideReason: "contract price",
        overriddenBy: "staff-user-497",
        position: 1,
      }),
    ]);
    const ids = Object.fromEntries(o.lineItems.map((l) => [l.productId, l.id]));
    await buyerEdit(o.id, [
      { productId: a, qty: 18, orderItemId: ids[a] },
      { productId: b, qty: 18, orderItemId: ids[b] },
    ]);
    const live = (await rows(o.id)).map(shape);
    expect(live[0]).toMatchObject({
      unitPrice: 15,
      priceType: "MANUAL",
      overrideReason: "upsell",
      subtotal: 22.5,
    });
    expect(live[1]).toMatchObject({
      unitPrice: 9,
      priceType: "SPECIAL",
      overrideReason: "contract price",
      subtotal: 13.5,
    });
  });

  it("R4: a PLAIN tier line (STANDARD, or SPECIAL with no reason) re-prices at the current tier", async () => {
    const a = await product("r4a");
    const b = await product("r4b");
    const o = await order([
      packLine(a, { unitPrice: "11.00", subtotal: "16.50", priceType: "STANDARD", position: 0 }),
      packLine(b, {
        unitPrice: "9.00",
        subtotal: "13.50",
        priceType: "SPECIAL",
        originalPrice: "12.00",
        position: 1,
      }),
    ]);
    const ids = Object.fromEntries(o.lineItems.map((l) => [l.productId, l.id]));
    await buyerEdit(o.id, [
      { productId: a, qty: 18, orderItemId: ids[a] },
      { productId: b, qty: 18, orderItemId: ids[b] },
    ]);
    const live = (await rows(o.id)).map(shape);
    // hand: customer tier 1 = the $12 box price: 12 + 6 x (12 / 12) = $18.00 each
    for (const l of live)
      expect(l).toMatchObject({
        unitPrice: 12,
        priceType: "STANDARD",
        subtotal: 18,
        overriddenBy: null,
      });
  });

  it("R5: a changed product prices at the tier; a new line beside a kept override carries no stamp", async () => {
    const a = await product("r5a");
    const b = await product("r5b");
    const o = await order([packLine(a, OVERRIDE)]);
    await buyerEdit(o.id, [
      { productId: a, qty: 18, orderItemId: o.lineItems[0].id },
      { productId: b, qty: 12 },
    ]);
    const live = (await rows(o.id)).map(shape);
    expect(live).toHaveLength(2);
    expect(live[0]).toMatchObject(KEPT);
    expect(live[1]).toMatchObject({
      productId: b,
      unitPrice: 12,
      priceType: "STANDARD",
      overrideReason: null,
      overriddenBy: null,
    });

    // the old product dropped, a different product added: the override does not follow the sale
    const o2 = await order([packLine(a, OVERRIDE)]);
    await buyerEdit(o2.id, [{ productId: b, qty: 12 }]);
    const live2 = (await rows(o2.id)).map(shape);
    expect(live2).toHaveLength(1);
    expect(live2[0]).toMatchObject({
      productId: b,
      unitPrice: 12,
      priceType: "STANDARD",
      overriddenBy: null,
    });
  });

  it("R6 (row 496): a staff edit with a formula-led overrideReason is a 400 and writes nothing", async () => {
    const p = await product("r6");
    const o = await order([packLine(p, OVERRIDE)]);
    const before = (await rows(o.id)).map(shape);
    await expect(
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(
          o.id,
          {
            items: [
              {
                id: o.lineItems[0].id,
                action: "UPDATE",
                qty: 18,
                unitPrice: 7,
                overrideReason: "=1+1",
              },
            ],
          },
          principal("OPERATOR", staffUserId),
        ),
      ),
    ).rejects.toMatchObject({ response: { code: "TEXT_CELL_FORMULA_LEAD" } });
    expect((await rows(o.id)).map(shape)).toEqual(before);
  });
});
