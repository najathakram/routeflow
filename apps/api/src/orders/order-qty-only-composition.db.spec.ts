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
 *   Q6 buyer AUTO-MERGE new-line path: a PLAIN qty = PACKS (SA-601/#2780, same as create); explicit
 *      boxes/pieces still wins (Q6c)
 *   Q8 PARITY: the same plain buyer qty via create(forceNew) and via the auto-merge new line stores
 *      identical columns + components for a boxed, a unit-sized and a recipe product
 *   Q7 DRIVER replace path, `pieceDenominated` arm (product already carries a box-aware line):
 *      same rule as Q6 (pieces % pack == 0 composes; else 400 FIXED_WHOLE_BOXES, nothing persisted)
 *   Q7c STAFF (OPERATOR) diff/merge branch: no split, qty = packs -> 2 packs = 48, boxes/pieces null
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
import { BuyerController } from "../buyer/buyer.controller";
import { fulfilmentUnsetProvider } from "../billing/testing/fulfilment-capability-provider";

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

  /** An existing mergeable (no skipAutoMerge) PENDING buyer order holding one plain product. */
  async function seedActiveBuyerOrder(w: World, tag: string) {
    const buyerRow = await seedBuyer(w, tag);
    const plain = await product(w, "plain-existing");
    const existing = (await inTenant(w.tenantId, () =>
      orders.create(
        { items: [qtyOnly(plain.id, 2)], status: "PENDING" },
        buyer(w, buyerRow.userId),
      ),
    )) as { id: string };
    return { ...buyerRow, plain, existing };
  }

  /** The buyer controller's auto-merge write: findActiveOrder -> updateOrderItems replaceAll. */
  const buyerMerge = (w: World, userId: string, customerId: string, incoming: unknown[]) =>
    inTenant(w.tenantId, async () => {
      const active = (await orders.findActiveOrder(customerId, { forMerge: true })) as {
        id: string;
        lineItems: { productId: string | null; qty: unknown }[];
      } | null;
      expect(active).not.toBeNull();
      const kept = (active?.lineItems ?? [])
        .filter((li) => li.productId)
        .map((li) => ({ productId: li.productId, qty: Number(li.qty) }));
      return orders.updateOrderItems(
        active?.id,
        { items: [...kept, ...incoming], replaceAll: true },
        buyer(w, userId),
      );
    });

  /** Stored money/quantity columns of a line, for byte-identity against the plain twin. */
  const cols = (l: {
    qty: unknown;
    boxes: unknown;
    pieces: unknown;
    unitsPerBox: unknown;
    unitPrice: unknown;
    subtotal: unknown;
  }) => ({
    qty: Number(l.qty),
    boxes: l.boxes,
    pieces: l.pieces,
    unitsPerBox: l.unitsPerBox,
    unitPrice: Number(l.unitPrice),
    subtotal: Number(l.subtotal),
  });

  async function mergeRecipeAndTwin(label: string, mixPayload: object) {
    const w = await seedWorld(label);
    const cat = await seedCatalog(w);
    const twin = await product(w, "plain-twin");
    const b = await seedActiveBuyerOrder(w, label);
    await buyerMerge(w, b.userId, b.customerId, [
      { productId: cat.mix.id, ...mixPayload },
      { productId: twin.id, ...mixPayload },
    ]);
    const lines = await linesOf(b.existing.id);
    const mixLine = lines.find((l) => l.productId === cat.mix.id);
    const twinLine = lines.find((l) => l.productId === twin.id);
    expect(mixLine).toBeDefined();
    expect(twinLine).toBeDefined();
    return { w, cat, mixLine: mixLine!, twinLine: twinLine!, lines };
  }

  const expectComposed72 = (
    w: World,
    cat: { v1: { id: string } | null; a: { id: string }; b: { id: string } },
    mixLine: Awaited<ReturnType<typeof linesOf>>[number],
    twinLine: Awaited<ReturnType<typeof linesOf>>[number],
  ) => {
    expect(mixLine).toMatchObject({ compositionMode: "FIXED", recipeId: cat.v1?.id });
    expect(mixLine.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      [cat.a.id, 36],
      [cat.b.id, 36],
    ]);
    expect(mixLine.components.reduce((s, c) => s + c.qty, 0)).toBe(72);
    for (const c of mixLine.components) expect(c.tenantId).toBe(w.tenantId);
    expect(Number(mixLine.qty)).toBe(72);
    expect(mixLine.boxes).toBe(3);
    expect(mixLine.pieces).toBe(0);
    expect(cols(mixLine)).toEqual(cols(twinLine));
    expect(twinLine.components).toEqual([]);
  };

  const driverCaller = (w: World, userId: string): JwtPayload =>
    ({
      sub: userId,
      username: "",
      role: "DRIVER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: w.tenantId,
      tenantSlug: w.slug,
    }) as JwtPayload;

  /**
   * A CONFIRMED order on the driver's own IN_PROGRESS run (assertDriverMayEditOrder), already
   * holding a BOX-AWARE line (qty 72, boxes 3, pieces 0, pack 24) for each product in `productIds`
   * -- exactly what puts those products in updateOrderItems' `pieceDenominated` set.
   */
  async function seedDriverOrder(w: World, productIds: string[]) {
    seq += 1;
    const du = await raw.user.create({
      data: {
        email: `drv-${run}-${seq}@example.test`,
        username: `drv-${run}-${seq}`,
        role: "DRIVER",
        tenantId: w.tenantId,
      },
    });
    const driver = await raw.driver.create({
      data: { userId: du.id, tenantId: w.tenantId } as any,
    });
    const customerId = await seedCustomer(w, "drv");
    const route = await raw.route.create({
      data: { name: `2717 route ${run}-${seq}`, tenantId: w.tenantId } as any,
    });
    const routeStop = await raw.routeStop.create({
      data: { tenantId: w.tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
    });
    const rr = await raw.routeRun.create({
      data: {
        tenantId: w.tenantId,
        routeId: route.id,
        scheduledDate: new Date("2026-09-27T00:00:00.000Z"),
        status: "IN_PROGRESS" as any,
        driverId: driver.id,
      },
    });
    const stop = await raw.routeRunStop.create({
      data: {
        tenantId: w.tenantId,
        routeRunId: rr.id,
        routeStopId: routeStop.id,
        stopNumber: 1,
        status: "PENDING" as any,
      } as any,
    });
    const order = await raw.order.create({
      data: {
        customerId,
        tenantId: w.tenantId,
        status: "CONFIRMED" as any,
        subtotal: String(90 * productIds.length),
        total: String(90 * productIds.length),
        routeRunId: rr.id,
        routeRunStopId: stop.id,
        lineItems: {
          create: productIds.map((productId, i) => ({
            tenantId: w.tenantId,
            productId,
            qty: 72,
            boxes: 3,
            pieces: 0,
            unitsPerBox: 24,
            unitPrice: "30.00",
            subtotal: "90.00",
            position: i,
          })),
        },
      },
    });
    return { orderId: order.id, driverUserId: du.id };
  }

  const driverEdit = (w: World, orderId: string, userId: string, items: unknown[]) =>
    inTenant(w.tenantId, () =>
      orders.updateOrderItems(orderId, { items, replaceAll: true }, driverCaller(w, userId)),
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
    await raw.routeRunStop.deleteMany({ where: { tenantId } });
    await raw.routeRun.deleteMany({ where: { tenantId } });
    await raw.routeStop.deleteMany({ where: { tenantId } });
    await raw.route.deleteMany({ where: { tenantId } });
    await raw.driver.deleteMany({ where: { tenantId } });
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

  // Q6 (SA-601 / #2780, PACK ONLY): on the buyer AUTO-MERGE path a PLAIN qty (no boxes/pieces/
  // unitLabel) is the DEFAULT SELLING UNIT = the PACK, exactly as create() stores it: qty N = N
  // packs, boxes/pieces null. (Was: re-split as PIECES.) An EXPLICIT boxes/pieces wins (Q6c).
  const expectComposedPacks = (
    w: World,
    cat: { v1: { id: string } | null; a: { id: string }; b: { id: string } },
    mixLine: Awaited<ReturnType<typeof linesOf>>[number],
    twinLine: Awaited<ReturnType<typeof linesOf>>[number],
    packs: number,
  ) => {
    expect(mixLine).toMatchObject({ compositionMode: "FIXED", recipeId: cat.v1?.id });
    // recipe = 12 + 12 per 24-piece pack, so each component carries 12 x packs.
    expect(mixLine.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      [cat.a.id, 12 * packs],
      [cat.b.id, 12 * packs],
    ]);
    expect(mixLine.components.reduce((n, c) => n + c.qty, 0)).toBe(packs * 24);
    for (const c of mixLine.components) expect(c.tenantId).toBe(w.tenantId);
    expect(Number(mixLine.qty)).toBe(packs); // stored as selling units (packs), not pieces
    expect(mixLine.boxes).toBeNull();
    expect(mixLine.pieces).toBeNull();
    expect(cols(mixLine)).toEqual(cols(twinLine));
    expect(twinLine.components).toEqual([]);
  };

  it("Q6a merge adds a NEW recipe line plain qty 72 = 72 PACKS: components sum 72 x 24 = 1728, stored qty 72, boxes/pieces null, equal to the plain twin and to forceNew", async () => {
    const { w, cat, mixLine, twinLine } = await mergeRecipeAndTwin("q6a", { qty: 72 });
    expectComposedPacks(w, cat, mixLine, twinLine, 72);
    expect(mixLine.components.reduce((n, c) => n + c.qty, 0)).toBe(1728);

    // The forceNew (create) path for the same payload stores the same columns + components.
    const w2 = await seedWorld("q6a-fn");
    const cat2 = await seedCatalog(w2);
    const b2 = await seedActiveBuyerOrder(w2, "q6a-fn");
    const created = (await inTenant(w2.tenantId, () =>
      orders.create({ items: [qtyOnly(cat2.mix.id, 72)], status: "PENDING" }, buyer(w2, b2.userId)),
    )) as { id: string };
    const [fn] = await linesOf(created.id);
    expect(cols(fn)).toEqual(cols(mixLine));
    expect(fn.components.map((c) => c.qty)).toEqual(mixLine.components.map((c) => c.qty));
  });

  it("Q6b merge adds plain qty 3 = 3 PACKS: composes (components sum 3 x 24 = 72), NOT a 400", async () => {
    const { w, cat, mixLine, twinLine } = await mergeRecipeAndTwin("q6b", { qty: 3 });
    expectComposedPacks(w, cat, mixLine, twinLine, 3);
    expect(mixLine.components.reduce((n, c) => n + c.qty, 0)).toBe(72);
    expect(await raw.order.count({ where: { tenantId: w.tenantId } })).toBe(1);
  });

  // Q6c UNCHANGED: an EXPLICIT boxes/pieces wins (qty 72 + boxes 3 = 72 pieces = 3 packs, boxes 3 stored).
  it("Q6c merge with explicit qty 72 + boxes 3, and with pieces 0: explicit split wins -> 3 packs, boxes 3 / pieces 0", async () => {
    for (const payload of [
      { qty: 72, boxes: 3 },
      { qty: 72, boxes: 3, pieces: 0 },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { w, cat, mixLine, twinLine } = await mergeRecipeAndTwin("q6c", payload);
      expectComposed72(w, cat, mixLine, twinLine);
    }
  });

  it("Q6d forceNew (create path, qty is packs) with an active order present: qty 2 composes 48, qty/boxes unchanged", async () => {
    const w = await seedWorld("q6d");
    const cat = await seedCatalog(w);
    const b = await seedActiveBuyerOrder(w, "q6d");

    const created = (await inTenant(w.tenantId, () =>
      orders.create({ items: [qtyOnly(cat.mix.id, 2)], status: "PENDING" }, buyer(w, b.userId)),
    )) as { id: string };

    expect(created.id).not.toBe(b.existing.id);
    const [l] = await linesOf(created.id);
    expect(l).toMatchObject({ compositionMode: "FIXED", recipeId: cat.v1?.id });
    expect(l.components.reduce((s, c) => s + c.qty, 0)).toBe(48);
    expect(Number(l.qty)).toBe(2);
    expect(l.boxes).toBeNull();
  });

  // Q7: the `pieceDenominated` arm of updateOrderItems' new-line split (NOT the buyer arms of Q6).
  // Reach: the CUSTOMER/DRIVER replace branch only. STAFF (OPERATOR) edits never enter it -- they go
  // through the merge branch below, which has no split -- so the arm is driven here as a DRIVER on
  // their own IN_PROGRESS run, on an order whose lines for these products are already box-aware.
  // PINS SA-593g: same rule as Q6 -- pieces % pack == 0 composes as packs, else 400, nothing written.
  it("Q7a DRIVER replace (pieceDenominated arm): qty 72 re-splits to 3 packs, composes 36+36; stored columns equal the plain twin's", async () => {
    const w = await seedWorld("q7a");
    const cat = await seedCatalog(w);
    const twin = await product(w, "plain-twin");
    const d = await seedDriverOrder(w, [cat.mix.id, twin.id]);

    await driverEdit(w, d.orderId, d.driverUserId, [
      { productId: cat.mix.id, qty: 72 },
      { productId: twin.id, qty: 72 },
    ]);

    const lines = await linesOf(d.orderId);
    const mixLine = lines.find((l) => l.productId === cat.mix.id);
    const twinLine = lines.find((l) => l.productId === twin.id);
    expect(mixLine).toBeDefined();
    expect(twinLine).toBeDefined();
    expectComposed72(w, cat, mixLine!, twinLine!);
  });

  it("Q7b DRIVER replace (pieceDenominated arm): qty 3 (3 loose pieces) -> 400 FIXED_WHOLE_BOXES; the order is unchanged", async () => {
    const w = await seedWorld("q7b");
    const cat = await seedCatalog(w);
    const d = await seedDriverOrder(w, [cat.mix.id]);
    const before = await linesOf(d.orderId);
    const orderBefore = await raw.order.findUniqueOrThrow({ where: { id: d.orderId } });
    const compsBefore = await componentCount(w.tenantId);

    await expect(
      driverEdit(w, d.orderId, d.driverUserId, [{ productId: cat.mix.id, qty: 3 }]),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: API_ERROR_CODES.FIXED_WHOLE_BOXES },
    });

    const after = await linesOf(d.orderId);
    expect(after.map((l) => [l.id, cols(l)])).toEqual(before.map((l) => [l.id, cols(l)]));
    const orderAfter = await raw.order.findUniqueOrThrow({ where: { id: d.orderId } });
    expect(Number(orderAfter.total)).toBe(Number(orderBefore.total));
    expect(Number(orderAfter.subtotal)).toBe(Number(orderBefore.subtotal));
    expect(await componentCount(w.tenantId)).toBe(compsBefore);
  });

  // Q7c: STAFF merge branch: no split, qty = packs (documents SA-593g: staff does NOT hit pieceDenominated).
  // An OPERATOR PATCH without `replaceAll` takes the diff/merge branch of updateOrderItems: a NEW
  // id-less qty-only line is added as-is (no normalizeBoxesPieces), so qty 2 = 2 packs = 48 pieces.
  it("Q7c STAFF merge branch: no split, qty = packs (documents SA-593g: staff does NOT hit pieceDenominated)", async () => {
    const w = await seedWorld("q7c");
    const cat = await seedCatalog(w);
    const twin = await product(w, "plain-twin");
    const other = await product(w, "existing-plain");
    const customerId = await seedCustomer(w, "q7c");
    const created = await create(w, customerId, [qtyOnly(other.id, 1)]);

    // No `replaceAll`: staff diff/merge branch, adds both new lines with the same qty-only payload.
    await edit(w, created.id, {
      items: [qtyOnly(cat.mix.id, 2), qtyOnly(twin.id, 2)],
    });

    const lines = await linesOf(created.id);
    const mixLine = lines.find((l) => l.productId === cat.mix.id);
    const twinLine = lines.find((l) => l.productId === twin.id);
    expect(mixLine).toBeDefined();
    expect(twinLine).toBeDefined();
    expect(mixLine).toMatchObject({ compositionMode: "FIXED", recipeId: cat.v1?.id });
    expect(mixLine!.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      [cat.a.id, 24],
      [cat.b.id, 24],
    ]);
    expect(mixLine!.components.reduce((n, c) => n + c.qty, 0)).toBe(48);
    for (const c of mixLine!.components) expect(c.tenantId).toBe(w.tenantId);
    expect(Number(mixLine!.qty)).toBe(2);
    expect(mixLine!.boxes).toBeNull();
    expect(mixLine!.pieces).toBeNull();
    expect(cols(mixLine!)).toEqual(cols(twinLine!));
    expect(twinLine!.components).toEqual([]);
  });

  // Q8 (SA-601 / #2780): PARITY. The same PLAIN buyer qty through create() (forceNew: a new order)
  // and through the auto-merge NEW line stores IDENTICAL qty/boxes/pieces/unitsPerBox/unitPrice/
  // subtotal and identical component sets, for a boxed (pack 24), a unit-sized (pack 1) and a
  // RECIPE product. Q7 (DRIVER, pieceDenominated arm = pieces) and Q7c (STAFF merge = packs) are
  // UNCHANGED by this ruling -- they are not buyer paths.
  const shapeOf = async (w: World, kind: "boxed" | "unit" | "recipe") => {
    if (kind === "recipe") return (await seedCatalog(w)).mix;
    return product(w, kind, kind === "unit" ? { unitsPerBox: 1, unit: "Each" } : {});
  };
  const lineShape = (l: Awaited<ReturnType<typeof linesOf>>[number]) => ({
    cols: cols(l),
    // non-regulated products only: both paths store 0/null here (see the regulated it.todo below).
    categoryTaxAmount: Number(l.categoryTaxAmount ?? 0),
    // component product ids differ per world; compare the ordered quantities.
    components: l.components.map((c) => c.qty),
  });

  it.each([
    ["boxed upb 24 plain product", "boxed", 5],
    ["unit-sized upb 1 product", "unit", 5],
    ["recipe product (5 packs = 120 pieces)", "recipe", 5],
  ] as const)(
    "Q8 parity: plain buyer qty %s via forceNew == via auto-merge new line",
    async (_n, kind, qty) => {
      const wA = await seedWorld(`q8a-${kind}`);
      const pA = await shapeOf(wA, kind);
      const bA = await seedActiveBuyerOrder(wA, `q8a-${kind}`);
      const created = (await inTenant(wA.tenantId, () =>
        orders.create({ items: [qtyOnly(pA.id, qty)], status: "PENDING" }, buyer(wA, bA.userId)),
      )) as { id: string };
      expect(created.id).not.toBe(bA.existing.id);
      const viaCreate = (await linesOf(created.id)).find((l) => l.productId === pA.id);

      const wB = await seedWorld(`q8b-${kind}`);
      const pB = await shapeOf(wB, kind);
      const bB = await seedActiveBuyerOrder(wB, `q8b-${kind}`);
      await buyerMerge(wB, bB.userId, bB.customerId, [{ productId: pB.id, qty }]);
      const viaMerge = (await linesOf(bB.existing.id)).find((l) => l.productId === pB.id);

      expect(viaCreate).toBeDefined();
      expect(viaMerge).toBeDefined();
      expect(Number(viaMerge!.qty)).toBe(qty); // selling units, never x pack / never re-split
      expect(viaMerge!.boxes).toBeNull();
      expect(viaMerge!.pieces).toBeNull();
      expect(lineShape(viaMerge!)).toEqual(lineShape(viaCreate!));
      if (kind === "recipe") {
        expect(viaMerge!.components.reduce((n, c) => n + c.qty, 0)).toBe(qty * 24);
      }
    },
  );

  it.todo(
    "Q8 LEAD-REVIEW (regulated product): create() writes categoryTaxAmount, the replace-all new-line branch stamps only the rate trio -- assert parity here once a regulated-category seed exists; deliberately NOT asserted (would hide a possible difference)",
  );

  // Q8e: END TO END through the REAL BuyerController.createOrder (guards/interceptors bypassed by
  // calling the method directly): no active order -> create() vs active order -> foldMergeItems ->
  // updateOrderItems({replaceAll}). Each path in its own world.
  const buyerController = () =>
    Object.assign(Object.create(BuyerController.prototype), {
      logger: new Logger(BuyerController.name),
      ordersService: orders,
      prisma,
      // Business profiles 1B: an unset seller, today's create call exactly.
      fulfilmentCapability: fulfilmentUnsetProvider.useValue,
    }) as BuyerController;
  const ctxOf = (w: World, b: { customerId: string; userId: string }) => ({
    customerId: b.customerId,
    tenantId: w.tenantId,
    tenantSlug: w.slug,
    userId: b.userId,
  });

  it.each([
    ["recipe product", "recipe"],
    ["boxed upb 24 plain product", "boxed"],
  ] as const)(
    "Q8e controller: plain buyer qty 3 on a %s via BuyerController.createOrder, create path == fold path",
    async (_n, kind) => {
      const wA = await seedWorld(`q8ea-${kind}`);
      const pA = await shapeOf(wA, kind);
      const bA = await seedBuyer(wA, `q8ea-${kind}`);
      const resA = (await inTenant(wA.tenantId, () =>
        buyerController().createOrder(
          { items: [{ productId: pA.id, qty: 3 }] } as any,
          ctxOf(wA, bA),
        ),
      )) as { id: string };
      const viaCreate = (await linesOf(resA.id)).find((l) => l.productId === pA.id);

      const wB = await seedWorld(`q8eb-${kind}`);
      const pB = await shapeOf(wB, kind);
      const bB = await seedActiveBuyerOrder(wB, `q8eb-${kind}`);
      const resB = (await inTenant(wB.tenantId, () =>
        buyerController().createOrder(
          { items: [{ productId: pB.id, qty: 3 }] } as any,
          ctxOf(wB, bB),
        ),
      )) as { id: string };
      expect(resB.id).toBe(bB.existing.id); // it really took the fold path
      const viaFold = (await linesOf(bB.existing.id)).find((l) => l.productId === pB.id);

      expect(viaCreate).toBeDefined();
      expect(viaFold).toBeDefined();
      expect(Number(viaFold!.qty)).toBe(3);
      expect(lineShape(viaFold!)).toEqual(lineShape(viaCreate!));
    },
  );

  it("Q8 explicit wins: qty 72 + boxes 3 on the merge new line stays a box split (3 boxes / 0 pieces), unlike the plain qty", async () => {
    const { mixLine, twinLine } = await mergeRecipeAndTwin("q8x", { qty: 72, boxes: 3 });
    expect(Number(mixLine.qty)).toBe(72);
    expect(mixLine.boxes).toBe(3);
    expect(mixLine.pieces).toBe(0);
    expect(cols(mixLine)).toEqual(cols(twinLine));
  });
});
