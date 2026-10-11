/**
 * #2717 M3 test-list items 25, 26, 27, 29, 31, 32 — real-Postgres proof that the ORDER writers keep
 * a FIXED line's frozen components consistent, through the real OrdersService (create, findOne,
 * updateOrderItems), RecipesService (activate) and CustomersService (hard delete).
 *
 *   25  staff create of a FIXED line persists components; sum = the line's pieces; tenantId is set
 *       on the nested rows (nested creates are not tenant-injected)
 *   26  a recipe whose components do not add up makes the WHOLE create roll back (I12, writing tx)
 *   27  updateOrderItems delete + recreate: old components cascade, new ones written, no orphans
 *   29  tenant isolation: B never reads A's components; B's RECIPE product on A's order is a 400
 *   31  activate(v2) racing an order create: line + ALL its components are v1 or ALL v2, never mixed
 *   32  customer hard delete and the tenant fresh-start wipe succeed with components present
 *
 * WRITTEN, NOT RUN by the lane that wrote it: DB specs are F2's (`npm run local:test:db`), which
 * adjusts any fixture field the schema demands. Builds a real OrdersService via `Object.create`
 * (no Nest DI), like orders-inline-return-create.db.spec.ts; `featureConfig` answers `on` for the
 * `mixed_packs` key. SAFETY: every tenant is a throwaway `qa-2717-comp-<run>-<n>-<label>` slug
 * approved by `assertTestTenant`; `requireLocalDatabaseUrl()` refuses a non-local host; `afterAll`
 * deletes exactly what those tenants hold.
 *
 * Test 32's wipe case runs the shipped `scripts/wipe-tenant-fresh-start.js --local --execute` as a
 * child process against the local DB. Its tenant holds a Recipe (+ RecipeComponent rows) and a
 * composed line stamped with it: EXPECTED RED until M2's wipe fix lands under M3 (SA-594).
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { spawnSync } from "node:child_process";
import path from "node:path";
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
import { RecipesService } from "../products/recipes.service";
import { CustomersService } from "../customers/customers.service";
import { OrdersService } from "./orders.service";
import * as snapshotAdapter from "./recipe-snapshot.adapter";
import type { RecipeSnapshot } from "./line-composition";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const WIPE_SCRIPT = path.join(API_DIR, "scripts", "wipe-tenant-fresh-start.js");

interface World {
  tenantId: string;
  slug: string;
  operatorId: string;
}

describeDb("#2717 M3 order composition writes — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client, deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let recipes: RecipesService;
  let customers: CustomersService;
  const run = randomUUID().slice(0, 8);
  const worlds: World[] = [];
  let seq = 0;
  const featureConfig = { getEffectiveMode: async () => "on" };

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  /**
   * Test 31's pause point (SA-591a). When `armedGate` is set, the FIRST ACTIVE-recipe read
   * (`recipe.findFirst` with `where.activeFor`) inside an OrdersService transaction signals
   * `reached` after its real result is in hand and then waits for `release` before returning.
   */
  interface Gate {
    reached: Promise<void>;
    release: Promise<void>;
    signalReached: () => void;
    open: () => void;
    taken: boolean;
  }
  let armedGate: Gate | null = null;
  const newGate = (): Gate => {
    let signalReached!: () => void;
    let open!: () => void;
    const reached = new Promise<void>((r) => (signalReached = r));
    const release = new Promise<void>((r) => (open = r));
    return { reached, release, signalReached, open, taken: false };
  };
  const gateTx = (tx: any): any =>
    new Proxy(tx, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (k === "recipe" && v) {
          return new Proxy(v, {
            get(rt, rk) {
              const rv = Reflect.get(rt, rk, rt);
              if (rk !== "findFirst" || typeof rv !== "function") {
                return typeof rv === "function" ? rv.bind(rt) : rv;
              }
              return async (args: any) => {
                const result = await rv.call(rt, args);
                const g = armedGate;
                if (g && !g.taken && args?.where?.activeFor) {
                  g.taken = true;
                  g.signalReached();
                  await g.release;
                }
                return result;
              };
            },
          });
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const gatedPrisma = (base: PrismaService): any =>
    new Proxy(base as any, {
      get(t, k) {
        if (k === "tenantTransaction") {
          return (fn: (tx: any) => Promise<unknown>, options?: unknown) =>
            t.tenantTransaction((tx: any) => fn(gateTx(tx)), options);
        }
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });

  async function seedWorld(label: string): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-2717-comp-${run}-${seq}-${label}`,
      "order-composition.db.spec.ts",
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
    return c.id;
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

  const line = (productId: string, boxes: number) => ({
    productId,
    boxes,
    pieces: 0,
    qty: boxes * 24,
  });

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

  /**
   * Polls until at least `n` backends of this database are blocked by ANYONE (< 5 s: Prisma's tx
   * timeout). Returns the last count seen, so a timeout reports how many actually blocked.
   */
  async function waitUntilNBlocked(n: number): Promise<number> {
    const deadline = Date.now() + 4_000;
    let seen = 0;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(pid)) > 0",
      );
      seen = rows[0].n;
      if (seen >= n) return seen;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    return seen;
  }

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
      prisma: gatedPrisma(prisma),
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
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: {
        validateSelectionsForCustomer: async () => undefined,
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
      },
    });
    recipes = new RecipesService(prisma, featureConfig as never);
    const stub = {} as never;
    customers = new CustomersService(
      prisma,
      { get: () => null } as never,
      stub,
      stub,
      stub,
      { hasFlag: async () => false } as never,
      stub,
      {
        reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
        syncInvoiceEntries: jest.fn(),
      } as never,
      stub,
    );
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

  // BREAK-IT: delete `await this.syncCompositions(tx, created.id);` in OrdersService.create()
  // (orders.service.ts, right after the `tx.order.create` inside the retry-loop transaction) and the
  // line commits with no components (`components` is [], compositionMode null) -> red. Writing a
  // different tenant's id on the createMany rows in syncLineCompositions (line-composition.ts,
  // `tenantId: ctx.tenantId`) turns the tenantId assertions red.
  it("25 staff create of a FIXED line persists components: sum = line pieces, tenantId set on the nested rows", async () => {
    const w = await seedWorld("create");
    const cat = await seedCatalog(w);
    const customerId = await seedCustomer(w, "c25");

    const created = await create(w, customerId, [line(cat.mix.id, 2)]);

    const [l] = await linesOf(created.id);
    expect(l).toMatchObject({
      compositionMode: "FIXED",
      recipeId: cat.v1?.id,
      recipeVersion: 1,
    });
    expect(Number(l.boxes)).toBe(2);
    expect(Number(l.unitsPerBox)).toBe(24);
    expect(l.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      [cat.a.id, 24],
      [cat.b.id, 24],
    ]);
    // I12: the components add up to exactly the line's pieces.
    expect(l.components.reduce((s, c) => s + c.qty, 0)).toBe(Number(l.qty));
    expect(l.components.map((c) => c.position)).toEqual([0, 1]);
    for (const c of l.components) {
      expect(c.tenantId).toBe(w.tenantId);
      expect(c.orderItemId).toBe(l.id);
      expect(c.name).toBe(c.componentProductId === cat.a.id ? cat.a.name : cat.b.name);
      expect(c.displayUnitPrice4).not.toBeNull();
    }
    expect(await componentCount(w.tenantId)).toBe(2);
  });

  // BREAK-IT: delete BOTH `assertComponentSum(...)` calls in line-composition.ts (the one inside
  // planFixedComposition and the one in syncLineCompositions) so a 23-piece recipe is accepted, or
  // move `await this.syncCompositions(tx, created.id)` in OrdersService.create() (orders.service.ts)
  // out of the tenantTransaction callback so it runs after the commit: the create then resolves
  // with an order whose components sum to 46, the `rejects` assertion goes red and the order
  // survives.
  it("26 a recipe whose components do not add up rolls the WHOLE create back: 0 orders, 0 lines, stock untouched", async () => {
    const w = await seedWorld("rollback");
    const cat = await seedCatalog(w);
    const customerId = await seedCustomer(w, "c26");
    const realPort = snapshotAdapter.recipeSnapshotPort;
    const portSpy = jest
      .spyOn(snapshotAdapter, "recipeSnapshotPort")
      .mockImplementation((tx, tenantId) => {
        const port = realPort(tx, tenantId);
        return {
          ...port,
          // The planner's input is short by one piece: 11 + 12 per 24-piece pack.
          activeRecipeFor: async (productId: string): Promise<RecipeSnapshot | null> => {
            const r = await port.activeRecipeFor(productId);
            if (!r) return r;
            return {
              ...r,
              comps: r.comps.map((c, i) => (i === 0 ? { ...c, qty: c.qty - 1 } : c)),
            };
          },
        };
      });

    await expect(create(w, customerId, [line(cat.mix.id, 2)])).rejects.toMatchObject({
      status: 400,
      response: { code: API_ERROR_CODES.COMPONENT_SUM_MISMATCH },
    });

    // The failure came from the sync INSIDE the tx (not a pre-tx refusal) ...
    expect(portSpy).toHaveBeenCalled();
    // ... so nothing of the create survives: no order, no line, no component, no stock booked.
    expect(await raw.order.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await raw.orderItem.count({ where: { order: { tenantId: w.tenantId } } })).toBe(0);
    expect(await componentCount(w.tenantId)).toBe(0);
    const mix = await raw.product.findUniqueOrThrow({ where: { id: cat.mix.id } });
    expect(Number(mix.currentStock)).toBe(100000);
    expect(await raw.stockMovement.count({ where: { productId: cat.mix.id } })).toBe(0);
  });

  // BREAK-IT: remove `await this.syncCompositions(tx, orderId);` at the end of
  // OrdersService.updateOrderItems() (orders.service.ts, before "Recalculate order totals") and the
  // re-created 3-box line keeps the carried 24 + 24 instead of 36 + 36 -> the qty assertion is red;
  // changing OrderItemComponent.orderItem `onDelete: Cascade` to Restrict (prisma/schema/sales.prisma)
  // makes the replace-all `tx.orderItem.deleteMany` fail with P2003 -> the edit rejects.
  it("27 updateOrderItems delete + recreate: old components cascade away, new ones are written, no orphan rows", async () => {
    const w = await seedWorld("edit");
    const cat = await seedCatalog(w);
    const plain = await product(w, "plain", { unitsPerBox: 1 });
    const customerId = await seedCustomer(w, "c27");
    const created = await create(w, customerId, [line(cat.mix.id, 2)]);
    const [before] = await linesOf(created.id);
    const oldLineId = before.id;
    const oldComponentIds = before.components.map((c) => c.id);
    expect(oldComponentIds).toHaveLength(2);

    await edit(w, created.id, { replaceAll: true, items: [line(cat.mix.id, 3)] });

    const [after] = await linesOf(created.id);
    expect(after.id).not.toBe(oldLineId);
    expect(after.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      [cat.a.id, 36],
      [cat.b.id, 36],
    ]);
    expect(after.components.reduce((s, c) => s + c.qty, 0)).toBe(Number(after.qty));
    for (const c of after.components) expect(c.tenantId).toBe(w.tenantId);
    // The old rows are gone, none points at the deleted line, and the tenant holds exactly the new pair.
    expect(await raw.orderItemComponent.count({ where: { id: { in: oldComponentIds } } })).toBe(0);
    expect(await raw.orderItemComponent.count({ where: { orderItemId: oldLineId } })).toBe(0);
    expect(await componentCount(w.tenantId)).toBe(2);

    // Replacing the composed line with a plain one leaves no component behind.
    await edit(w, created.id, { replaceAll: true, items: [{ productId: plain.id, qty: 2 }] });
    const rest = await linesOf(created.id);
    expect(rest).toHaveLength(1);
    expect(rest[0].productId).toBe(plain.id);
    expect(rest[0].components).toEqual([]);
    expect(await componentCount(w.tenantId)).toBe(0);
  });

  // BREAK-IT: drop the tenant scoping from the read side (e.g. make OrdersService.findOne's
  // `this.prisma.forTenant().order.findUnique` an unscoped `this.prisma.order.findUnique`) and B's
  // findOne returns A's order with its components -> the 404 assertion is red; make the product
  // lookup in OrdersService.create() (`this.prisma.forTenant().product.findMany`, ~line 1590)
  // unscoped and B's RECIPE product is accepted onto A's order -> the 400 assertion is red.
  it("29 tenant isolation: B never reads A's components, and B's RECIPE product on A's order is a 400", async () => {
    const a = await seedWorld("iso-a");
    const b = await seedWorld("iso-b");
    const catA = await seedCatalog(a);
    const catB = await seedCatalog(b);
    const custA = await seedCustomer(a, "c29a");
    const orderA = await create(a, custA, [line(catA.mix.id, 2)]);

    // Positive control: A reads its own two components; they are stamped with A's tenant.
    const seenByA = (await inTenant(a.tenantId, () => orders.findOne(orderA.id, staff(a)))) as {
      lineItems: { components: unknown[] }[];
    };
    expect(seenByA.lineItems).toHaveLength(1);
    expect(seenByA.lineItems[0].components).toHaveLength(2);
    expect(await componentCount(a.tenantId)).toBe(2);
    expect(await componentCount(b.tenantId)).toBe(0);

    // B cannot read A's order at all, so it cannot read A's components.
    await expect(
      inTenant(b.tenantId, () => orders.findOne(orderA.id, staff(b))),
    ).rejects.toMatchObject({ status: 404 });

    // B's RECIPE product on A's order: refused on create and on a replace-all edit, nothing written.
    await expect(create(a, custA, [line(catB.mix.id, 1)])).rejects.toMatchObject({ status: 400 });
    await expect(
      edit(a, orderA.id, { replaceAll: true, items: [line(catB.mix.id, 1)] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await raw.order.count({ where: { tenantId: a.tenantId } })).toBe(1);
    const [untouched] = await linesOf(orderA.id);
    expect(untouched.productId).toBe(catA.mix.id);
    expect(untouched.components.map((c) => c.qty)).toEqual([24, 24]);
    expect(await componentCount(b.tenantId)).toBe(0);
  });

  // BREAK-IT (SA-591a): in recipe-snapshot.adapter.ts make `activeRecipeFor` select the recipe
  // WITHOUT components, then read them via `tx.recipeComponent.findMany({ where: { recipe: {
  // activeFor: productId } } })` (re-resolving the ACTIVE recipe instead of using the recipeId just
  // read). The gate pauses the create right after its ACTIVE-recipe read; when v2's activation
  // commits during that pause, the line is stamped v1 but reads v2's components -> the per-round
  // CONTENT assertion (stamp and ALL components the same version) is red. Dropping the recipe-product
  // row lock (`lockProductRow` in RecipesService.activate / the FOR UPDATE stock lock in
  // order-stock.ts) is caught by the same assertion.
  it("31 RACE (4 rounds): activate(v2) vs an order create leaves the line and ALL its components on v1 or ALL on v2", async () => {
    const w = await seedWorld("race");
    const customerId = await seedCustomer(w, "c31");
    const outcomes = {
      version: { 1: 0, 2: 0 } as Record<number, number>,
      activation: { "committed-during-pause": 0, "queued-behind-create": 0 },
    };
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const family = await product(w, "family", { kind: "FAMILY" });
      // eslint-disable-next-line no-await-in-loop
      const a = await product(w, "flavor-a", { parentProductId: family.id, kind: "VARIANT" });
      // eslint-disable-next-line no-await-in-loop
      const b = await product(w, "flavor-b", { parentProductId: family.id, kind: "VARIANT" });
      // eslint-disable-next-line no-await-in-loop
      const mix = await product(w, "mix");
      const comps = (x: number, y: number) => [
        { componentProductId: a.id, qty: x },
        { componentProductId: b.id, qty: y },
      ];
      // eslint-disable-next-line no-await-in-loop
      const v1 = await inTenant(w.tenantId, () =>
        recipes.create({
          recipeProductId: mix.id,
          familyProductId: family.id,
          unitsPerPack: 24,
          components: comps(12, 12),
        } as never),
      );
      // eslint-disable-next-line no-await-in-loop
      await inTenant(w.tenantId, () => recipes.activate(v1.id));
      // eslint-disable-next-line no-await-in-loop
      const v2 = await inTenant(w.tenantId, () => recipes.createVersion(v1.id));
      // eslint-disable-next-line no-await-in-loop
      await inTenant(w.tenantId, () =>
        recipes.update(v2.id, { components: comps(6, 18) } as never),
      );

      // Pause the create right after its ACTIVE-recipe read, activate v2 meanwhile, then release.
      const gate = newGate();
      armedGate = gate;
      let activation: "committed-during-pause" | "queued-behind-create";
      let both: PromiseSettledResult<unknown>[] = [];
      try {
        const created = create(w, customerId, [line(mix.id, 2)]);
        // A create that fails before the read must not hang the round.
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([
          gate.reached,
          created.then(
            () => undefined,
            () => undefined,
          ),
        ]);
        const activated = inTenant(w.tenantId, () => recipes.activate(v2.id));
        let settled = false;
        const activatedSettled = activated.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        // Either the activation commits while the create is paused, or it queues behind the
        // create's product-row lock. Wait <= 1.5 s for either; never past 4 s (tx timeout 5 s).
        const started = Date.now();
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([
          activatedSettled,
          waitUntilNBlocked(1),
          new Promise((r) => setTimeout(r, 1_500)),
        ]);
        activation = settled ? "committed-during-pause" : "queued-behind-create";
        expect(Date.now() - started).toBeLessThan(4_000);
        gate.open();
        // eslint-disable-next-line no-await-in-loop
        both = await Promise.allSettled([activated, created]);
      } finally {
        gate.open();
        armedGate = null;
      }

      // CONTENT assertions first: stamp and ALL components are one version, sum = pieces.
      const [activated, ordered] = both;
      expect(activated.status).toBe("fulfilled");
      expect(ordered.status).toBe("fulfilled");
      const orderId = (ordered as PromiseFulfilledResult<{ id: string }>).value.id;

      // Read only after both settled: the refetch is the truth, not the return value.
      // eslint-disable-next-line no-await-in-loop
      const [l] = await linesOf(orderId);
      // eslint-disable-next-line no-await-in-loop
      const active = await raw.recipe.findMany({
        where: { productId: mix.id, status: "ACTIVE" },
      });
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(v2.id); // the activation always lands
      const version = Number(l.recipeVersion);
      expect([1, 2]).toContain(version);
      expect(l.recipeId).toBe(version === 1 ? v1.id : v2.id);
      expect(l.components.map((c) => [c.componentProductId, c.qty])).toEqual(
        version === 1
          ? [
              [a.id, 24],
              [b.id, 24],
            ]
          : [
              [a.id, 12],
              [b.id, 36],
            ],
      );
      expect(l.components.reduce((s, c) => s + c.qty, 0)).toBe(Number(l.qty));
      outcomes.version[version] += 1;
      // Informational only: which branch this round took (neither fails the test).
      outcomes.activation[activation] += 1;
    }
    expect(outcomes.version[1] + outcomes.version[2]).toBe(4);
    // eslint-disable-next-line no-console
    console.info(
      `test 31: activation committed-during-pause in ${outcomes.activation["committed-during-pause"]} round(s), queued-behind-create in ${outcomes.activation["queued-behind-create"]}; lines on v1=${outcomes.version[1]}, v2=${outcomes.version[2]}`,
    );
  }, 120_000);

  // BREAK-IT (customer hard delete): remove `await tx.orderItem.deleteMany({ where: { orderId: { in:
  // orderIds } } });` before `tx.order.deleteMany` in CustomersService.deleteAllCustomers()
  // (customers.service.ts ~2604), or make OrderItemComponent.orderItem `onDelete: Restrict`
  // (prisma/schema/sales.prisma): the delete then aborts with a FK error / 409 -> red.
  it("32a customer hard delete succeeds with components present, and the component products survive", async () => {
    const w = await seedWorld("cust-delete");
    const cat = await seedCatalog(w);
    const customerId = await seedCustomer(w, "c32a");
    // DRAFT: a draft books no stock, so the only rows hanging off the order are the line + components.
    const created = await create(w, customerId, [line(cat.mix.id, 2)], "DRAFT");
    expect((await linesOf(created.id))[0].components).toHaveLength(2);
    expect(await componentCount(w.tenantId)).toBe(2);

    await expect(inTenant(w.tenantId, () => customers.deleteAllCustomers())).resolves.toEqual({
      deleted: 1,
    });

    expect(await raw.customer.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await raw.order.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await raw.orderItem.count({ where: { orderId: created.id } })).toBe(0);
    expect(await componentCount(w.tenantId)).toBe(0);
    expect(await raw.product.count({ where: { id: { in: [cat.a.id, cat.b.id] } } })).toBe(2);
  }, 60_000);

  // EXPECTED RED until M2's wipe fix lands under M3 (SA-594); it then goes green. The tenant seeded
  // here holds a real Recipe + RecipeComponent rows and a composed line stamped with that recipe;
  // wipe-tenant-fresh-start.js does not list Recipe / RecipeComponent today and Recipe.productId is
  // Restrict, so the product delete aborts the wipe transaction (#2741 owns the script fix).
  // BREAK-IT (tenant reset): move "product" above "orderItem" in NUKE_MODELS in
  // scripts/wipe-tenant-fresh-start.js (or make OrderItemComponent.orderItem `onDelete: Restrict`
  // in prisma/schema/sales.prisma): the product delete meets the RESTRICT FK from
  // OrderItemComponent.componentProductId (or the line delete meets its components) and the single
  // wipe transaction rolls back -> exit code != 0 and the rows are still there. After the M2 fix,
  // removing Recipe / RecipeComponent from the wipe's NUKE_MODELS turns it red again (Restrict FK).
  it("32b the tenant fresh-start wipe succeeds with a recipe and components present (FK order: components cascade from the line)", async () => {
    const w = await seedWorld("wipe");
    // Seeds a real ACTIVE Recipe v1 + its RecipeComponent rows (the wipe must delete them too).
    const cat = await seedCatalog(w);
    const customerId = await seedCustomer(w, "c32b");
    await raw.order.create({
      data: {
        customerId,
        tenantId: w.tenantId,
        status: "PENDING",
        subtotal: "60.00",
        total: "60.00",
        lineItems: {
          create: [
            {
              tenantId: w.tenantId,
              productId: cat.mix.id,
              qty: 48,
              boxes: 2,
              pieces: 0,
              unitsPerBox: 24,
              unitPrice: "30.00",
              subtotal: "60.00",
              compositionMode: "FIXED",
              recipeId: cat.v1!.id,
              recipeVersion: 1,
              position: 0,
              components: {
                create: [
                  {
                    tenantId: w.tenantId,
                    componentProductId: cat.a.id,
                    qty: 24,
                    name: "A",
                    position: 0,
                  },
                  {
                    tenantId: w.tenantId,
                    componentProductId: cat.b.id,
                    qty: 24,
                    name: "B",
                    position: 1,
                  },
                ],
              },
            },
          ],
        },
      },
    });
    expect(await componentCount(w.tenantId)).toBe(2);
    expect(await raw.recipe.count({ where: { tenantId: w.tenantId } })).toBe(1);
    expect(await raw.recipeComponent.count({ where: { tenantId: w.tenantId } })).toBe(2);

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("RAILWAY_") ||
        key.startsWith("POSTGRES_") ||
        key.startsWith("PG") ||
        key === "NODE_ENV" ||
        (key.startsWith("DATABASE_") && key !== "DATABASE_URL")
      )
        delete env[key];
    }
    env.DATABASE_URL = requireLocalDatabaseUrl();
    const res = spawnSync(process.execPath, [WIPE_SCRIPT, w.slug, "--local", "--execute"], {
      cwd: API_DIR,
      encoding: "utf8",
      env,
      input: `${w.slug}\n`,
      timeout: 90_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect({ status: res.status, tail: out.slice(-300) }).toMatchObject({ status: 0 });

    expect(await componentCount(w.tenantId)).toBe(0);
    expect(await raw.recipeComponent.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await raw.recipe.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await raw.orderItem.count({ where: { order: { tenantId: w.tenantId } } })).toBe(0);
    expect(await raw.order.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await raw.customer.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await raw.product.count({ where: { tenantId: w.tenantId } })).toBe(0);
    // The wipe keeps the tenant shell and the operator login.
    expect(await raw.tenant.count({ where: { id: w.tenantId } })).toBe(1);
  }, 120_000);
});
