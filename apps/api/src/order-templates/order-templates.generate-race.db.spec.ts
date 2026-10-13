/**
 * B1054 review — real-Postgres proof that the 06:00 cron and a manual "Generate now" of the SAME
 * standing order, running at the same time, place exactly ONE order. Before the fix the cron looked
 * for today's order without the template lock and passed no `replaySince`, so both runs could pass
 * their checks, each place an order, and the real pending-order merge then folded the pair into one
 * order carrying the quantity twice.
 *
 * Deterministic barrier (no sleeps standing in for ordering): a raw pg client holds the template row
 * lock (`FOR NO KEY UPDATE`, the lock the generating transaction takes first), BOTH runs are started,
 * the spec waits until Postgres reports two backends blocked on that lock, and only then releases it.
 * Both runs therefore passed every unlocked check before either could write.
 *
 * Real: PrismaService, OrderTemplatesService (incl. the cron method), the real merge on its real
 * advisory lock, decrementStockForSale. Stubbed: notifications, license guard, selling restrictions,
 * tax config. The cron's tenant list is narrowed to the throwaway tenant (a Proxy over PrismaService)
 * so the spec never generates orders for any other tenant in the local database.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). One throwaway `qa-b1054-race-<run>`
 * tenant approved by `assertTestTenant`; afterAll deletes exactly the rows this run created.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client, Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { OrdersService } from "../orders/orders.service";
import { OrderTemplatesService } from "./order-templates.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const START_STOCK = 100;
const TEMPLATE_QTY = 5;
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]; // the cron selects by today's weekday: due every day

describeDb("cron vs manual generate of one template places ONE order (B1054)", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client, deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let templates: OrderTemplatesService; // the manual path
  let cronTemplates: OrderTemplatesService; // same service over a prisma whose tenant list is just ours
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b1054-race-${run}`, "order-templates.generate-race.db.spec.ts");
  let tenantId = "";
  let operator: JwtPayload;
  let customerId = "";
  let productId = "";
  let otherProductId = "";
  let templateId = "";

  const generate = (id = templateId) =>
    tenantCtx.run(tenantId, () => templates.generateOrderForUser(id, operator)) as Promise<any>;

  const stock = async (id = productId) =>
    Number((await raw.product.findUniqueOrThrow({ where: { id } })).currentStock);
  const orders = () =>
    raw.order.findMany({
      where: { tenantId },
      include: { lineItems: true },
      orderBy: { createdAt: "asc" },
    });
  const qtyOf = (
    order: { lineItems: Array<{ productId: string | null; qty: unknown }> },
    p = productId,
  ) => order.lineItems.filter((l) => l.productId === p).reduce((s, l) => s + Number(l.qty), 0);

  async function reset() {
    await raw.stockMovement.deleteMany({ where: { product: { tenantId } } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.product.update({ where: { id: productId }, data: { currentStock: START_STOCK } });
    await raw.product.update({
      where: { id: otherProductId },
      data: { currentStock: START_STOCK },
    });
  }

  /** Block until Postgres shows `n` backends waiting on a template row lock. */
  async function waitForBlockedOnTemplateLock(n: number) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query ILIKE '%FOR NO KEY UPDATE%' AND query LIKE '%"OrderTemplate"%'`,
      );
      if (Number(rows[0].n) >= n) return;
      if (Date.now() > deadline) {
        throw new Error(`only ${rows[0].n} of ${n} runs reached the template lock within 20 s`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function buildTemplatesService(prismaForService: PrismaService, ordersService: OrdersService) {
    return new OrderTemplatesService(
      prismaForService,
      tenantCtx,
      ordersService,
      { checkAuthorized: async () => ({ blocked: [] }) } as any,
      { sendToCustomer: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue("0") } as any, // settings.taxRate: 0% keeps the sums plain
      {
        assertLinesSellable: jest.fn().mockResolvedValue(undefined),
        checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
      } as any,
      { read: async () => "off" } as any,
    );
  }

  // Only T1 exists while the cron test runs: the cron generates EVERY due template of the tenant.
  const makeTemplate = (name: string, pid: string) =>
    raw.orderTemplate.create({
      data: {
        tenantId,
        customerId,
        name,
        daysOfWeek: ALL_WEEKDAYS,
        createdByRole: UserRole.OPERATOR,
        itemsEditedByRole: UserRole.OPERATOR,
        items: { create: [{ tenantId, productId: pid, qty: TEMPLATE_QTY }] },
      },
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const ordersService = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      tenantCtx,
      gateway: {
        emitOrderCreated: jest.fn(),
        emitUrgentOrder: jest.fn(),
        emitOrderStatusChanged: jest.fn(),
        emitLowStock: jest.fn(),
      },
      notifications: {
        sendToCustomer: jest.fn().mockResolvedValue(undefined),
        sendToUser: jest.fn().mockResolvedValue(1),
      },
      messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
      entitlements: { hasFlag: async () => true },
      systemConfig: { get: async () => "0" }, // settings.taxRate: 0% keeps the sums plain
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
        checkLinesSellable: async () => ({ outcome: "ALLOW", reasons: [] }),
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      invoicesService: {
        findOpenOrderDraft: async () => null,
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => "off" },
    }) as OrdersService;
    templates = buildTemplatesService(prisma, ordersService);

    tenantId = (await raw.tenant.create({ data: { slug, name: `B1054 race ${slug}` } })).id;
    // The cron lists ACTIVE tenants from the whole database; narrow that one read to ours. Every
    // other member is forwarded to the real PrismaService, bound to it (its internals are private).
    const scoped = new Proxy(prisma, {
      get(target, key) {
        if (key === "tenant") return { findMany: async () => [{ id: tenantId }] };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    cronTemplates = buildTemplatesService(scoped as unknown as PrismaService, ordersService);

    const opUser = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    operator = {
      sub: opUser.id,
      username: opUser.username,
      role: UserRole.OPERATOR,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    } as JwtPayload;
    const buyer = await raw.user.create({
      data: {
        email: `buyer-${run}@example.test`,
        username: `buyer-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: buyer.id, businessName: `Cust ${run}`, contactName: "B1054", tenantId },
      })
    ).id;
    const product = (name: string) =>
      raw.product.create({
        data: {
          tenantId,
          name: `${name} ${run}`,
          unit: "each",
          pricePerUnit: 10,
          currentStock: START_STOCK,
        },
      });
    productId = (await product("p1")).id;
    otherProductId = (await product("p2")).id;
    templateId = (await makeTemplate(`T1 ${run}`, productId)).id;
  });

  beforeEach(reset);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    const where = { where: { tenantId } };
    await raw.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
    await raw.orderItem.deleteMany(where).catch(swallow);
    await raw.order.deleteMany(where).catch(swallow);
    await raw.orderTemplateItem.deleteMany(where).catch(swallow);
    await raw.orderTemplate.deleteMany(where).catch(swallow);
    await raw.product.deleteMany(where).catch(swallow);
    await raw.customer.deleteMany(where).catch(swallow);
    await raw.auditLog.deleteMany(where).catch(swallow);
    await raw.user.deleteMany(where).catch(swallow);
    await raw.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  });

  it("REG-B1054: the cron and a manual run started together on one template place ONE order of 5", async () => {
    const holder = new Client({ connectionString: requireLocalDatabaseUrl() });
    await holder.connect();
    let cron: Promise<void> | undefined;
    let manual: Promise<any> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "OrderTemplate" WHERE id = $1 FOR NO KEY UPDATE`, [
        templateId,
      ]);
      cron = cronTemplates.generateDailyOrders();
      manual = generate();
      // Both runs have passed their unlocked checks (no order exists) and now wait for the lock.
      await waitForBlockedOnTemplateLock(2);
    } finally {
      await holder.query("COMMIT").catch(() => undefined);
      await holder.end().catch(() => undefined);
      // Never leave a run in flight past a barrier timeout: its writes would overlap reset()/afterAll.
      await Promise.allSettled([cron, manual].filter(Boolean));
    }
    const [cronResult, manualResult] = await Promise.allSettled([cron!, manual!]);
    expect(cronResult.status).toBe("fulfilled");
    expect(manualResult.status).toBe("fulfilled");

    // The persisted numbers are asserted before the manual caller's answer. With the template lock
    // reverted, the red run is usually the barrier above timing out (nothing blocks on the lock), not
    // a wrong value here; without the replay re-read two orders are placed and the merge folds them
    // into one carrying qty 10 and stock 90.
    const all = await orders();
    expect(all.filter((o) => o.templateId === templateId).map((o) => qtyOf(o))).toEqual([
      TEMPLATE_QTY,
    ]);
    expect(await stock()).toBe(START_STOCK - TEMPLATE_QTY);
    // whichever run won the lock, the manual caller is answered with the one order that exists
    expect((manualResult as PromiseFulfilledResult<any>).value.id).toBe(all[0].id);
  });

  it("pin (accepted limit): an order that lost a merge is no longer a replay target, so a retry places a new one", async () => {
    const other = await makeTemplate(`T2 ${run}`, otherProductId);
    try {
      const first = await generate(templateId);
      await generate(other.id); // the pending-order merge folds T1's order into T2's newer one
      expect(await raw.order.findUnique({ where: { id: first.id } })).toBeNull();

      const retry = await generate(templateId); // inside the 30 s window, but the marker is gone

      expect(retry.id).not.toBe(first.id);
      expect(await stock(productId)).toBe(START_STOCK - 2 * TEMPLATE_QTY); // taken twice
    } finally {
      await reset(); // orders first: they reference the template
      await raw.orderTemplateItem.deleteMany({ where: { templateId: other.id } });
      await raw.orderTemplate.delete({ where: { id: other.id } });
    }
  });
});
