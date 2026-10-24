/**
 * #2717 M3 (SA-591 b, SA-579 case 8) — real-Postgres proof THROUGH OrdersService.updateOrderItems():
 * after recipe v2 activates, a staff replace-all edit of an order holding a v1 line keeps that line
 * on v1 (stamp and components rescaled from its OWN stored per-box counts), while a line added by
 * the same edit takes the ACTIVE v2.
 *
 * WRITTEN, NOT RUN by the lane that wrote it: DB specs are F2's (`npm run local:test:db`), which
 * adjusts any fixture field the schema demands. Builds a real OrdersService via `Object.create`
 * (no Nest DI), like buyer-unit-line-diff.db.spec.ts; `featureConfig` answers `on` for the
 * `mixed_packs` key. SAFETY: one throwaway `qa-2717-edit-<run>` tenant approved by
 * `assertTestTenant`; `afterAll` deletes exactly the rows this run created.
 *
 * REVERT-RED: drop the `carry.restore` call after the replace-all create and the surviving line
 * comes back stamped v2 with v2's components.
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

describeDb("#2717 M3 SA-591(b) — an edit keeps a v1 line on v1, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2717-edit-${run}`, "order-edit-recipe-version.db.spec.ts");
  let tenantId = "";
  let customerId = "";
  let userId = "";
  let customerUserId = "";
  const orderIds: string[] = [];
  const productIds: string[] = [];

  const staff = (): JwtPayload =>
    ({
      sub: userId,
      username: `op-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  // SA-603b: a product NAME is unique among ACTIVE products of its scope, so each seed() needs its own names.
  let nameSeq = 0;
  const product = async (name: string, extra: Record<string, unknown> = {}) => {
    nameSeq += 1;
    const p = await raw.product.create({
      data: {
        tenantId,
        name: `${name} ${run}-${nameSeq}`,
        unit: "Box",
        pricePerUnit: "30.00",
        unitsPerBox: 24,
        currentStock: "100000",
        ...extra,
      } as never,
    });
    productIds.push(p.id);
    return p;
  };

  async function seed() {
    const family = await product("family", { kind: "FAMILY" });
    const a = await product("flavor-a", { parentProductId: family.id, kind: "VARIANT" });
    const b = await product("flavor-b", { parentProductId: family.id, kind: "VARIANT" });
    const mix = await product("mix", { kind: "RECIPE" });
    const v1 = await raw.recipe.create({
      data: {
        tenantId,
        productId: mix.id,
        familyProductId: family.id,
        version: 1,
        unitsPerPack: 24,
        status: "ACTIVE",
        activeFor: mix.id,
        components: {
          create: [
            { tenantId, componentProductId: a.id, qty: 12, position: 0 },
            { tenantId, componentProductId: b.id, qty: 12, position: 1 },
          ],
        },
      },
    });
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: "60.00",
        total: "60.00",
        lineItems: {
          create: [
            {
              tenantId,
              productId: mix.id,
              qty: 48,
              boxes: 2,
              pieces: 0,
              unitsPerBox: 24,
              unitPrice: "30.00",
              subtotal: "60.00",
              compositionMode: "FIXED",
              recipeId: v1.id,
              recipeVersion: 1,
              position: 0,
              components: {
                create: [
                  { tenantId, componentProductId: a.id, qty: 24, name: "A", position: 0 },
                  { tenantId, componentProductId: b.id, qty: 24, name: "B", position: 1 },
                ],
              },
            },
          ],
        },
      },
    });
    orderIds.push(order.id);
    // v2 activates: v1 retires, v2 (6 + 18 per pack) becomes the ACTIVE recipe.
    await raw.recipe.update({ where: { id: v1.id }, data: { status: "RETIRED", activeFor: null } });
    const v2 = await raw.recipe.create({
      data: {
        tenantId,
        productId: mix.id,
        familyProductId: family.id,
        version: 2,
        unitsPerPack: 24,
        status: "ACTIVE",
        activeFor: mix.id,
        components: {
          create: [
            { tenantId, componentProductId: a.id, qty: 6, position: 0 },
            { tenantId, componentProductId: b.id, qty: 18, position: 1 },
          ],
        },
      },
    });
    return { orderId: order.id, mixId: mix.id, aId: a.id, bId: b.id, v1, v2 };
  }

  const edit = (orderId: string, dto: any) =>
    tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, staff()));
  const linesOf = (orderId: string) =>
    raw.orderItem.findMany({
      where: { orderId },
      orderBy: { position: "asc" },
      include: { components: { orderBy: { position: "asc" } } },
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
      featureConfig: { getEffectiveMode: async () => "on" },
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
    tenantId = (await raw.tenant.create({ data: { slug, name: `2717 ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
    customerUserId = (
      await raw.user.create({
        data: {
          email: `cust-${run}@example.test`,
          username: `cust-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: customerUserId, businessName: "2717 co", contactName: "Tester", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.recipe.deleteMany({ where: { tenantId } });
    await raw.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await raw.product.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: { in: [userId, customerUserId] } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("a v1 line resized 2 -> 3 boxes stays v1 (36 + 36 pieces), never v2's 18 + 54", async () => {
    const f = await seed();
    await edit(f.orderId, {
      replaceAll: true,
      items: [{ productId: f.mixId, boxes: 3, pieces: 0, qty: 72 }],
    });
    const [line] = await linesOf(f.orderId);
    expect(line.boxes).toBe(3);
    expect(line.recipeId).toBe(f.v1.id);
    expect(line.recipeVersion).toBe(1);
    expect(line.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      [f.aId, 36],
      [f.bId, 36],
    ]);
  });

  it("an id-less replaceAll naming one product TWICE over one line is refused (row 373 strict pairing), not guessed", async () => {
    const f = await seed();
    await expect(
      edit(f.orderId, {
        replaceAll: true,
        items: [
          { productId: f.mixId, boxes: 2, pieces: 0, qty: 48 },
          { productId: f.mixId, boxes: 1, pieces: 0, qty: 24 },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: "ORDER_EDIT_NEEDS_LINE_IDS" } });
    expect(await linesOf(f.orderId)).toHaveLength(1); // nothing written
  });

  it("the same edit that adds a second line (the existing line NAMED by id): the survivor stays v1, the new line gets the ACTIVE v2", async () => {
    const f = await seed();
    // row 373: every real client names its existing lines (web/mobile staff edits are id diffs, buyers send
    // orderItemId with namesLines); an id-less repeat of one product over a line is refused, never paired by guess
    const [existing] = await linesOf(f.orderId);
    await edit(f.orderId, {
      replaceAll: true,
      items: [
        { id: existing.id, productId: f.mixId, boxes: 2, pieces: 0, qty: 48 },
        { productId: f.mixId, boxes: 1, pieces: 0, qty: 24 },
      ],
    });
    const lines = await linesOf(f.orderId);
    expect(lines).toHaveLength(2);
    expect(lines[0].recipeVersion).toBe(1);
    expect(lines[0].components.map((c) => c.qty)).toEqual([24, 24]);
    expect(lines[1].recipeVersion).toBe(2);
    expect(lines[1].recipeId).toBe(f.v2.id);
    expect(lines[1].components.map((c) => c.qty)).toEqual([6, 18]);
    for (const l of lines) {
      expect(l.components.reduce((s, c) => s + c.qty, 0)).toBe((l.boxes ?? 0) * 24);
    }
  });
});
