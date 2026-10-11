/**
 * B1054 — real-Postgres proof that "Generate order now" is idempotent. `generateOrder` had no guard:
 * a double click, a retried request or the buyer's Reorder pressed twice each placed ANOTHER order
 * for the same standing order, decremented the stock again and then folded the pair together through
 * the real pending-order merge (so the one surviving order carried the template's quantities twice).
 *
 * Real: PrismaService, OrderTemplatesService, OrdersService.mergeAllPendingForCustomer (the real
 * merge, on its real advisory lock), decrementStockForSale. Stubbed: the collaborators whose output
 * the proof does not depend on (notifications, license guard, selling restrictions, tax config).
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). One throwaway `qa-b1054-<run>` tenant
 * approved by `assertTestTenant`; afterAll deletes exactly the rows this run created, in FK order.
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

describeDb("generate order now is idempotent (B1054)", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client, deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let templates: OrderTemplatesService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b1054-${run}`, "generate-now-idempotent-b1054.db.spec.ts");
  let tenantId = "";
  let operator: JwtPayload;
  let customerId = "";
  let productId = "";
  let otherProductId = "";
  let templateId = "";
  let otherTemplateId = "";

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
    });
    templates = new OrderTemplatesService(
      prisma,
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

    tenantId = (await raw.tenant.create({ data: { slug, name: `B1054 ${slug}` } })).id;
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
    const template = (name: string, pid: string) =>
      raw.orderTemplate.create({
        data: {
          tenantId,
          customerId,
          name,
          daysOfWeek: [1],
          createdByRole: UserRole.OPERATOR,
          itemsEditedByRole: UserRole.OPERATOR,
          items: { create: [{ tenantId, productId: pid, qty: TEMPLATE_QTY }] },
        },
      });
    templateId = (await template(`T1 ${run}`, productId)).id;
    otherTemplateId = (await template(`T2 ${run}`, otherProductId)).id;
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

  it("REG-B1054: a double click (two calls in a row) places ONE order of 5, not a merged 10", async () => {
    const first = await generate();
    const second = await generate();

    // The persisted numbers first, so a red run names the wrong value: today the second call
    // places another order and the merge folds the pair into one carrying qty 10 and stock 90.
    const all = await orders();
    expect(all.map((o) => qtyOf(o))).toEqual([TEMPLATE_QTY]);
    expect(await stock()).toBe(START_STOCK - TEMPLATE_QTY);
    expect(second.id).toBe(first.id); // the replay answers with the order the first call placed
  });

  it("REG-B1054: two CONCURRENT calls place ONE order of 5 and both answer with it", async () => {
    // A held row lock is the barrier: both calls pass their unlocked checks (no order yet) and
    // queue on the template row, so the locked re-read is what answers the second one.
    const holder = new Client({ connectionString: requireLocalDatabaseUrl() });
    await holder.connect();
    let first: Promise<any> | undefined;
    let second: Promise<any> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "OrderTemplate" WHERE id = $1 FOR NO KEY UPDATE`, [
        templateId,
      ]);
      first = generate();
      second = generate();
      await waitForBlockedOnTemplateLock(2);
    } finally {
      await holder.query("COMMIT").catch(() => undefined);
      await holder.end().catch(() => undefined);
      // Never leave a call in flight past a barrier timeout: it would overlap reset()/afterAll.
      await Promise.allSettled([first, second].filter(Boolean));
    }
    const [a, b] = await Promise.all([first!, second!]);

    const all = await orders();
    expect(all.map((o) => qtyOf(o))).toEqual([TEMPLATE_QTY]);
    expect(await stock()).toBe(START_STOCK - TEMPLATE_QTY);
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(all[0].id);
  });

  it("pin: a run well after the first (older than the guard window) is a deliberate new order", async () => {
    const first = await generate();
    await raw.order.update({
      where: { id: first.id },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const again = await generate();

    expect(again.id).not.toBe(first.id);
    expect(await stock()).toBe(START_STOCK - 2 * TEMPLATE_QTY); // two real orders' worth taken
  });

  it("pin: a CANCELLED order never blocks the next run (the operator cancelled and re-ran on purpose)", async () => {
    const first = await generate();
    await raw.order.update({ where: { id: first.id }, data: { status: "CANCELLED" } });

    const again = await generate();

    expect(again.id).not.toBe(first.id);
  });

  it("pin: another template of the same customer is its own run, never replayed as this one", async () => {
    const first = await generate(templateId);
    const other = await generate(otherTemplateId);

    expect(other.id).not.toBe(first.id);
    const all = await orders();
    // the pending-order merge folds both templates' lines into the newest order
    expect(all).toHaveLength(1);
    expect(qtyOf(all[0], productId)).toBe(TEMPLATE_QTY);
    expect(qtyOf(all[0], otherProductId)).toBe(TEMPLATE_QTY);
  });
});
