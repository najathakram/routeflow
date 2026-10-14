/**
 * H1 / M1 DB-lane proof (real Postgres, throwaway `qa-*` tenants): deleting a product never deletes order or
 * invoice history, the keep-or-remove decision is made under the product row lock, and "active" is read off the
 * ORDER's status (an OrderItem.status never advances past PENDING).
 *
 * Run by the DB lane (`npm run local:test:db`); collected only by `jest.db.config.js`. `requireLocalDatabaseUrl()`
 * refuses any non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
 *
 * The two races are deterministic: a second transaction holds a row lock (or an uncommitted order line) while
 * `bulkDelete` runs, and the spec waits until Postgres reports a blocked backend before it lets the sale commit.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

type OrderState = "PENDING" | "CONFIRMED" | "DELIVERED" | "CANCELLED";

describeDb("product delete keeps order and invoice history (H1, M1) - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: ProductsService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
            upload: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    tenantId: string;
    customerId: string;
  }

  async function seedWorld(label: string): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-h1-${RUN}-${seq}-${label}`,
      "products-bulk-delete-keeps-history.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `h1 ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `c-${RUN}-${seq}@example.test`,
        username: `c-${RUN}-${seq}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "Acme Retail",
        contactName: "H1 Tester",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, customerId: customer.id };
  }

  const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);

  async function product(w: World, name: string, id?: string): Promise<string> {
    const row = await prisma.product.create({
      data: {
        ...(id ? { id } : {}),
        tenantId: w.tenantId,
        name: `${name} ${RUN}-${(seq += 1)}`,
        unit: "each",
        pricePerUnit: "2.00",
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  /** An order with one line for the product, plus (optionally) an invoice with one line. Returns the ids. */
  async function sale(
    w: World,
    productId: string,
    state: OrderState,
    opts: { invoice?: "PAID" | "DRAFT" } = {},
    client: { order: PrismaService["order"]; invoice: PrismaService["invoice"] } = prisma,
  ): Promise<{ orderId: string; orderItemId: string; invoiceId: string | null }> {
    seq += 1;
    const order = await client.order.create({
      data: {
        customerId: w.customerId,
        tenantId: w.tenantId,
        status: state,
        subtotal: "2.00",
        total: "2.00",
        lineItems: {
          create: [
            {
              tenantId: w.tenantId,
              productId,
              qty: 1,
              unitPrice: "2.00",
              subtotal: "2.00",
              position: 0,
            },
          ],
        },
      },
      include: { lineItems: { select: { id: true } } },
    });
    const orderItemId = order.lineItems[0].id;
    let invoiceId: string | null = null;
    if (opts.invoice) {
      const invoice = await client.invoice.create({
        data: {
          tenantId: w.tenantId,
          customerId: w.customerId,
          orderId: order.id,
          invoiceNumber: `INV-H1-${RUN}-${seq}`,
          status: opts.invoice,
          subtotal: "2.00",
          total: "2.00",
          items: {
            create: [
              {
                tenantId: w.tenantId,
                productId,
                orderItemId,
                description: "Acme item",
                qty: 1,
                unitPrice: "2.00",
                subtotal: "2.00",
              },
            ],
          },
        },
      });
      invoiceId = invoice.id;
    }
    return { orderId: order.id, orderItemId, invoiceId };
  }

  const lineCounts = async (orderId: string, invoiceId: string | null) => ({
    orderLines: await prisma.orderItem.count({ where: { orderId } }),
    invoiceLines: invoiceId ? await prisma.invoiceItem.count({ where: { invoiceId } }) : 0,
  });

  const row = (id: string) =>
    prisma.product.findUnique({ where: { id }, select: { id: true, isActive: true } });

  /** Waits until Postgres reports a backend blocked on a lock (the delete is waiting on the holder). */
  async function waitForBlockedBackend(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (n > 0) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("bulkDelete never blocked on the holder's lock");
  }

  describe("keeps history", () => {
    it("a product on a DELIVERED order with a PAID invoice is deactivated; both documents keep their lines", async () => {
      const w = await seedWorld("delivered");
      const p = await product(w, "Soda");
      const s = await sale(w, p, "DELIVERED", { invoice: "PAID" });

      const result = await inTenant(w, () => service.bulkDelete([p]));

      // M1: not refused as "active order items"; the outcome is the archive path.
      expect(result).toEqual({ deleted: 0, softDeleted: 1, skipped: [] });
      expect(await row(p)).toEqual({ id: p, isActive: false });
      expect(await lineCounts(s.orderId, s.invoiceId)).toEqual({ orderLines: 1, invoiceLines: 1 });
    });

    it("a product sold only on a CANCELLED order is deactivated too", async () => {
      const w = await seedWorld("cancelled");
      const p = await product(w, "Juice");
      const s = await sale(w, p, "CANCELLED");

      const result = await inTenant(w, () => service.bulkDelete([p]));

      expect(result).toEqual({ deleted: 0, softDeleted: 1, skipped: [] });
      expect(await lineCounts(s.orderId, null)).toEqual({ orderLines: 1, invoiceLines: 0 });
    });

    it.each(["PENDING", "CONFIRMED"] as const)(
      "a product on a %s order is skipped with PRODUCT_HAS_ACTIVE_ORDER_ITEMS and left active",
      async (state) => {
        const w = await seedWorld(`open-${state}`);
        const p = await product(w, "Chips");
        const s = await sale(w, p, state);

        const result = await inTenant(w, () => service.bulkDelete([p]));

        expect(result.deleted).toBe(0);
        expect(result.softDeleted).toBe(0);
        expect(result.skipped).toEqual([
          { id: p, code: "PRODUCT_HAS_ACTIVE_ORDER_ITEMS", reason: expect.any(String) },
        ]);
        expect(await row(p)).toEqual({ id: p, isActive: true });
        expect((await lineCounts(s.orderId, null)).orderLines).toBe(1);
      },
    );

    it("a product nothing names is removed", async () => {
      const w = await seedWorld("unreferenced");
      const p = await product(w, "Gum");

      const result = await inTenant(w, () => service.bulkDelete([p]));

      expect(result).toEqual({ deleted: 1, softDeleted: 0, skipped: [] });
      expect(await row(p)).toBeNull();
    });

    it("single delete: a product sold only on a DELIVERED order is archived; one on a PENDING order is refused with a code", async () => {
      const w = await seedWorld("single");
      const done = await product(w, "Tea");
      const open = await product(w, "Coffee");
      await sale(w, done, "DELIVERED");
      await sale(w, open, "PENDING");

      await inTenant(w, () => service.remove(done));
      expect(await row(done)).toEqual({ id: done, isActive: false });

      const err = await inTenant(w, () => service.remove(open)).catch((e: unknown) => e);
      expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: "PRODUCT_HAS_ACTIVE_ORDER_ITEMS",
      });
      expect(await row(open)).toEqual({ id: open, isActive: true });
    });
  });

  describe("the race: a sale commits after the delete classified the product as unreferenced", () => {
    // Q sorts before P. A holder keeps Q's row locked, so bulkDelete([Q, P]) waits on Q AFTER its first look
    // classified P as unreferenced. A sale of P commits in that window, then the holder lets go.
    // Ids are global primary keys: a fresh pair per test (hex only, so JS and database sort orders agree).
    let pairNo = 0;
    const pair = () => {
      pairNo += 1;
      const tail = `${RUN}${String(pairNo).padStart(4, "0")}`;
      return {
        Q_ID: `00000000-0000-4000-8000-${tail}`,
        P_ID: `ffffffff-0000-4000-8000-${tail}`,
      };
    };

    async function holdRow(productId: string) {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      const done = prisma.$transaction(
        async (h) => {
          await h.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      await lockedP;
      return { release, done };
    }

    it("a sale of P that commits during the wait keeps its order and invoice lines; P is deactivated, not removed", async () => {
      const w = await seedWorld("race-delivered");
      const { Q_ID, P_ID } = pair();
      const q = await product(w, "Held", Q_ID);
      const p = await product(w, "Sold", P_ID);
      // Q carries history of its own, so it is on the archive path (and the batch needs its row lock).
      await prisma.stockMovement.create({
        data: { tenantId: w.tenantId, productId: q, type: "ADJUSTMENT", quantity: 1 },
      });

      const holder = await holdRow(q);
      const bulk = inTenant(w, () => service.bulkDelete([q, p])).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForBlockedBackend();
      const s = await sale(w, p, "DELIVERED", { invoice: "PAID" });
      holder.release();
      await holder.done;
      const outcome = await bulk;

      // Never a 500 and never a loss: the lines are there and P is still a row.
      expect(await lineCounts(s.orderId, s.invoiceId)).toEqual({ orderLines: 1, invoiceLines: 1 });
      expect(await row(p)).toEqual({ id: p, isActive: false });
      expect(outcome).toEqual({
        ok: true,
        value: { deleted: 0, softDeleted: 2, skipped: [] },
      });
    });

    it("a sale of P on an OPEN order that commits during the wait refuses P with the coded reason; the order keeps its line", async () => {
      const w = await seedWorld("race-open");
      const { P_ID, Q_ID } = pair();
      const q = await product(w, "Held", Q_ID);
      const p = await product(w, "Sold", P_ID);
      await prisma.stockMovement.create({
        data: { tenantId: w.tenantId, productId: q, type: "ADJUSTMENT", quantity: 1 },
      });

      const holder = await holdRow(q);
      const bulk = inTenant(w, () => service.bulkDelete([q, p]));
      await waitForBlockedBackend();
      const s = await sale(w, p, "PENDING");
      holder.release();
      await holder.done;
      const result = await bulk;

      expect(result.deleted).toBe(0);
      expect(result.softDeleted).toBe(1);
      expect(result.skipped).toEqual([
        { id: p, code: "PRODUCT_HAS_ACTIVE_ORDER_ITEMS", reason: expect.any(String) },
      ]);
      expect(await row(p)).toEqual({ id: p, isActive: true });
      expect((await lineCounts(s.orderId, null)).orderLines).toBe(1);
    });

    it("an order line that is written but not yet committed when the delete starts: the delete waits for it and then keeps the product", async () => {
      const w = await seedWorld("race-inflight");
      const { P_ID } = pair();
      const p = await product(w, "Sold", P_ID);

      // The sale's transaction inserts the order and its line (a KEY SHARE lock on P) and stays open.
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      let inserted!: (v: { orderId: string }) => void;
      const insertedP = new Promise<{ orderId: string }>((r) => (inserted = r));
      const saleTx = prisma.$transaction(
        async (t) => {
          const s = await sale(w, p, "DELIVERED", {}, t as never);
          inserted({ orderId: s.orderId });
          await finished;
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      const { orderId } = await insertedP;

      const bulk = inTenant(w, () => service.bulkDelete([p]));
      await waitForBlockedBackend();
      finish();
      await saleTx;
      const result = await bulk;

      expect(result).toEqual({ deleted: 0, softDeleted: 1, skipped: [] });
      expect(await row(p)).toEqual({ id: p, isActive: false });
      expect((await lineCounts(orderId, null)).orderLines).toBe(1);
    });
  });
});
