/**
 * SA-593e fold 2 (#2717 M3): a QTY-ONLY (selling-unit) order line of a RECIPE product with an
 * ACTIVE recipe composes as `qty` whole packs. Real-Postgres proof through the real OrdersService
 * (create as staff and as a buyer, updateOrderItems).
 *
 *   Q1 staff create composes; components sum = qty x pack, stamp FIXED, money/qty columns untouched
 *   Q2 non-integer qty -> 400 FIXED_WHOLE_BOXES, nothing persisted
 *   Q3 no ACTIVE recipe -> plain line
 *   Q4 buyer cart path (create with a CUSTOMER caller) composes the same; buyer isolation
 *   Q5 edit 2 -> 3 keeps and rescales the components
 *
 * WRITTEN, NOT RUN by the lane that wrote it: DB specs are F2's (`npm run local:test:db`), which
 * adjusts any fixture field the schema demands. Harness mirrors order-composition.db.spec.ts.
 * SAFETY: throwaway `qa-2717-qo-<run>-<n>-<label>` tenants approved by `assertTestTenant`.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

interface World {
  tenantId: string;
  slug: string;
  operatorId: string;
}

describeDb("#2717 M3 qty-only RECIPE line composition — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const worlds: World[] = [];
  let seq = 0;
  const featureConfig = { getEffectiveMode: async () => "on" };

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function seedWorld(label: string): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-2717-qo-${run}-${seq}-${label}`,
      "order-qty-only-composition.db.spec.ts",
    );
    const tenantId = (await raw.tenant.create({ data: { slug, name: `2717 ${slug}` } })).id;
    const operator = await raw.user.create({
      data: {
        email: `op-${run}-${seq}@example.test`,
        username: `op-${run}-${seq}`,
        role: "OPERATOR",
        tenantId,
      },
    });
    const w = { tenantId, slug, operatorId: operator.id };
    worlds.push(w);
    return w;
  }

  const staff = (w: World): JwtPayload =>
    ({
      sub: w.operatorId,
      username: `op-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: w.tenantId,
      tenantSlug: w.slug,
    }) as JwtPayload;

  async function seedCustomer(w: World, tag: string): Promise<string> {
    return (await seedBuyer(w, tag)).customerId;
  }

  async function seedBuyer(w: World, tag: string): Promise<{ customerId: string; userId: string }> {
    seq += 1;
    const u = await raw.user.create({
      data: {
        email: `${tag}-${run}-${seq}@example.test`,
        username: `${tag}-${run}-${seq}`,
        role: "CUSTOMER",
        tenantId: w.tenantId,
      },
    });
    const c = await raw.customer.create({
      data: {
        userId: u.id,
        businessName: `${tag} co`,
        contactName: "2717 Tester",
        tenantId: w.tenantId,
      },
    });
    return { customerId: c.id, userId: u.id };
  }

  const product = (
    w: World,
    name: string,
    extra: Partial<Prisma.ProductUncheckedCreateInput> = {},
  ) => {
    seq += 1;
    return raw.product.create({
      data: {
        tenantId: w.tenantId,
        name: `${name} ${run}-${seq}`,
        sku: `S-${randomUUID().slice(0, 8)}`,
        unit: "Box",
        pricePerUnit: "30.00",
        unitsPerBox: 24,
        currentStock: "100000",
        ...extra,
      },
    });
  };

  /**
   * family -> variants A/B -> RECIPE product `mix`. With `recipeRow`, an ACTIVE v1 (12 + 12 per
   * 24-piece pack) is written straight to the tables (activeFor = mix).
   */
  async function seedCatalog(w: World, opts: { recipeRow?: boolean } = {}) {
    const recipeRow = opts.recipeRow ?? true;
    const family = await product(w, "family", { kind: "FAMILY" });
    const a = await product(w, "flavor-a", { parentProductId: family.id, kind: "VARIANT" });
    const b = await product(w, "flavor-b", { parentProductId: family.id, kind: "VARIANT" });
    const mix = await product(w, "mix", { kind: "RECIPE" });
    const v1 = recipeRow
      ? await raw.recipe.create({
          data: {
            tenantId: w.tenantId,
            productId: mix.id,
            familyProductId: family.id,
            version: 1,
            unitsPerPack: 24,
            status: "ACTIVE",
            activeFor: mix.id,
            components: {
              create: [
                { tenantId: w.tenantId, componentProductId: a.id, qty: 12, position: 0 },
                { tenantId: w.tenantId, componentProductId: b.id, qty: 12, position: 1 },
              ],
            },
          },
        })
      : null;
    return { family, a, b, mix, v1 };
  }

  const create = (
    w: World,
    customerId: string,
    items: unknown[],
    status?: "DRAFT" | "PENDING",
  ): Promise<{ id: string }> =>
    inTenant(
      w.tenantId,
      () =>
        orders.create({ customerId, items, ...(status ? { status } : {}) }, staff(w), {
          skipAutoMerge: true,
        }) as Promise<{ id: string }>,
    );
  const edit = (w: World, orderId: string, dto: unknown) =>
    inTenant(w.tenantId, () => orders.updateOrderItems(orderId, dto, staff(w)));
  const linesOf = (orderId: string) =>
    raw.orderItem.findMany({
      where: { orderId },
      orderBy: { position: "asc" },
      include: { components: { orderBy: { position: "asc" } } },
    });
  const componentCount = (tenantId: string) =>
    raw.orderItemComponent.count({ where: { tenantId } });

  const buyer = (w: World, userId: string): JwtPayload =>
    ({
      sub: userId,
      username: "",
      role: "CUSTOMER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: w.tenantId,
      tenantSlug: w.slug,
      type: "BUYER",
    }) as JwtPayload;

  /** A selling-unit line: no boxes, no pieces. `qty` is the pack count. */
  const qtyOnly = (productId: string, qty: number) => ({ productId, qty });

  const buyerCreate = (w: World, userId: string, items: unknown[]): Promise<{ id: string }> =>
    inTenant(
      w.tenantId,
      () =>
        orders.create({ items, status: "PENDING" }, buyer(w, userId), {
          skipAutoMerge: true,
        }) as Promise<{ id: string }>,
    );
  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
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
      gateway: {
        emitOrderStatusChanged: jest.fn(),
        emitOrderCreated: jest.fn(),
        emitUrgentOrder: jest.fn(),
      },
      systemConfig,
      featureConfig,
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
      creditNotes: {
        validateSelectionsForCustomer: async () => undefined,
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
      },
    });
  }, 120_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    for (const w of worlds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupWorld(w.tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  /** FK order: lines (components cascade) -> orders -> recipes -> products -> customers -> tenant. */
  async function cleanupWorld(tenantId: string): Promise<void> {
    const orderIds = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    const productIds = (
      await raw.product.findMany({ where: { tenantId }, select: { id: true } })
    ).map((p) => p.id);
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.recipeComponent.deleteMany({ where: { tenantId } });
    await raw.recipe.deleteMany({ where: { tenantId } });
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await raw.product.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
  }

  // BREAK-IT: in syncLineCompositions (line-composition.ts) replace `effectiveBoxes({...})` with
  // `Number(l.boxes ?? 0)`: the qty-only line is treated as struck, no components -> red.
  it("Q1 staff create of a qty-only RECIPE line composes qty x pack; money and quantity columns untouched", async () => {
    const w = await seedWorld("staff");
    const cat = await seedCatalog(w);
    const customerId = await seedCustomer(w, "q1");

    const created = await create(w, customerId, [qtyOnly(cat.mix.id, 2)]);

    const [l] = await linesOf(created.id);
    expect(l).toMatchObject({ compositionMode: "FIXED", recipeId: cat.v1?.id, recipeVersion: 1 });
    expect(l.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      [cat.a.id, 24],
      [cat.b.id, 24],
    ]);
    expect(l.components.reduce((s, c) => s + c.qty, 0)).toBe(2 * 24);
    for (const c of l.components) expect(c.tenantId).toBe(w.tenantId);
    // Composition never rewrites the line: still a selling-unit line at the BOX price.
    expect(Number(l.qty)).toBe(2);
    expect(l.boxes).toBeNull();
    expect(l.pieces).toBeNull();
    expect(Number(l.unitPrice)).toBe(30);
    expect(Number(l.subtotal)).toBe(60);
  });

  // BREAK-IT: skip assertWholeBoxes in planFixedComposition -> 2.5 composes 60 pieces, resolves.
  it("Q2 qty 2.5 -> 400 FIXED_WHOLE_BOXES and NOTHING is persisted (no order row)", async () => {
    const w = await seedWorld("frac");
    const cat = await seedCatalog(w);
    const customerId = await seedCustomer(w, "q2");

    await expect(create(w, customerId, [qtyOnly(cat.mix.id, 2.5)])).rejects.toMatchObject({
      status: 400,
      response: { code: API_ERROR_CODES.FIXED_WHOLE_BOXES },
    });
    expect(await raw.order.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await raw.orderItem.count({ where: { order: { tenantId: w.tenantId } } })).toBe(0);
    expect(await componentCount(w.tenantId)).toBe(0);
  });

  it("Q3 a RECIPE product with no ACTIVE recipe: plain line, no components, no stamp", async () => {
    const w = await seedWorld("norecipe");
    const cat = await seedCatalog(w, { recipeRow: false });
    const customerId = await seedCustomer(w, "q3");

    const created = await create(w, customerId, [qtyOnly(cat.mix.id, 2)]);

    const [l] = await linesOf(created.id);
    expect(l.compositionMode).not.toBe("FIXED");
    expect(l.recipeId).toBeNull();
    expect(l.components).toEqual([]);
    expect(Number(l.qty)).toBe(2);
    expect(await componentCount(w.tenantId)).toBe(0);
  });

  // The buyer path is OrdersService.create() with a CUSTOMER caller (buyer.controller createOrder
  // -> ordersService.create), so it runs the same syncCompositions inside the same tx.
  it("Q4 BUYER cart path composes the same, and buyer B cannot see buyer A's components", async () => {
    const w = await seedWorld("buyer");
    const cat = await seedCatalog(w);
    const a = await seedBuyer(w, "q4a");
    const b = await seedBuyer(w, "q4b");

    const orderA = await buyerCreate(w, a.userId, [qtyOnly(cat.mix.id, 2)]);

    const [l] = await linesOf(orderA.id);
    expect(l).toMatchObject({ compositionMode: "FIXED", recipeId: cat.v1?.id, recipeVersion: 1 });
    expect(l.components.map((c) => c.qty)).toEqual([24, 24]);
    expect(l.components.reduce((s, c) => s + c.qty, 0)).toBe(48);
    expect(Number(l.qty)).toBe(2);
    expect(l.boxes).toBeNull();

    // Positive control: A reads its own components.
    const seenByA = (await inTenant(w.tenantId, () =>
      orders.findOne(orderA.id, buyer(w, a.userId)),
    )) as { lineItems: { components: unknown[] }[] };
    expect(seenByA.lineItems[0].components).toHaveLength(2);
    // B cannot read A's order, so cannot read its components.
    const err = await inTenant(w.tenantId, () =>
      orders.findOne(orderA.id, buyer(w, b.userId)),
    ).then(
      () => null,
      (e: { status?: number }) => e,
    );
    expect([403, 404]).toContain(err?.status);
    // A fractional buyer qty is refused the same way, and persists nothing further.
    await expect(buyerCreate(w, b.userId, [qtyOnly(cat.mix.id, 1.5)])).rejects.toMatchObject({
      status: 400,
      response: { code: API_ERROR_CODES.FIXED_WHOLE_BOXES },
    });
    expect(await raw.order.count({ where: { tenantId: w.tenantId } })).toBe(1);
  });

  // BREAK-IT: in restore/sync make the FIXED branch use `Number(l.boxes ?? 0)` -> the re-created
  // qty-only line is struck and its components are deleted (or stay 24+24).
  it("Q5 edit 2 -> 3 of a qty-only composed line keeps its components and rescales them to 36 + 36", async () => {
    const w = await seedWorld("edit");
    const cat = await seedCatalog(w);
    const customerId = await seedCustomer(w, "q5");
    const created = await create(w, customerId, [qtyOnly(cat.mix.id, 2)]);

    await edit(w, created.id, { replaceAll: true, items: [qtyOnly(cat.mix.id, 3)] });

    const [after] = await linesOf(created.id);
    expect(after).toMatchObject({
      compositionMode: "FIXED",
      recipeId: cat.v1?.id,
      recipeVersion: 1,
    });
    expect(after.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      [cat.a.id, 36],
      [cat.b.id, 36],
    ]);
    expect(Number(after.qty)).toBe(3);
    expect(after.boxes).toBeNull();
    expect(await componentCount(w.tenantId)).toBe(2);
  });
});
