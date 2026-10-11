/**
 * B297 PR3 (SA-734r2 B3 / B4 / L1, L-169) — real-Postgres pins that a regulated order line is recomputed
 * at its OWN stamped rate trio and never at the live TrackedCategory rate, through each of the four
 * OrdersService callers of the one recompute: updateOrderItems, mergeAllPendingForCustomer,
 * forceConsolidateCustomer and approveChangeRequestAtStop. The lines are created by the REAL
 * OrdersService.create (which stamps the trio), the category rate is then RAISED, and the operation must
 * leave the stamped rate in force. A NULL-trio (legacy) line prices at the live rate once, stamps it and is
 * never re-priced again; a line with no category keeps its stored excise (L1). The pins also guard against
 * a future `select` that drops the trio from one caller's line load (L-169): that caller would read the
 * trio as NULL and re-stamp at the live rate.
 *
 * Each case fails on master's live-rate recompute on its own wrong value. Builds a REAL OrdersService via
 * `Object.create` (no Nest DI), as merge-eligibility-race-b1053.db.spec.ts does.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host; the tenant is a throwaway `qa-b297-<run>` slug
 * approved by `assertTestTenant`; `afterAll` deletes exactly the rows this run created.
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
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SNAPSHOT_RATE = 0.05;
const LIVE_RATE = 0.07;

describeDb("B297 PR3 — a recompute reads the line's rate snapshot, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b297-${run}`, "b297-recompute-snapshot.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let driverUserId = "";
  let driverId = "";
  let customerId = "";
  let categoryId = "";
  let productId = "";
  const routeIds: string[] = [];
  const warn = jest.spyOn(Logger.prototype, "warn");

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
  const driver = (): JwtPayload =>
    ({
      sub: driverUserId,
      username: `dr-${run}`,
      role: "DRIVER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const edit = (orderId: string, dto: any) =>
    inTenant(() => orders.updateOrderItems(orderId, dto, operator()));
  const raiseCategoryRate = (rate: number) =>
    raw.trackedCategory.update({ where: { id: categoryId }, data: { rate } });

  /** A real staff create: the writer stamps the trio at the category's rate AT THAT MOMENT. */
  const createOrder = async (qty: number) => {
    const created: any = await inTenant(() =>
      orders.create({ customerId, items: [{ productId, qty }] }, operator(), {
        skipAutoMerge: true,
      }),
    );
    await raw.orderItem.updateMany({ where: { orderId: created.id }, data: { deliveredQty: 0 } });
    await raw.order.update({ where: { id: created.id }, data: { skipAutoMerge: false } });
    return created.id as string;
  };
  const lines = async (orderId: string) => {
    const rows = await raw.orderItem.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      qty: Number(r.qty),
      amount: Number(r.categoryTaxAmount),
      type: r.categoryTaxType,
      rate: r.categoryTaxRate == null ? null : Number(r.categoryTaxRate),
      includes: r.categoryPriceIncludesTax,
      trackedCategoryId: r.trackedCategoryId,
    }));
  };
  const warnedAbout = (id: string) =>
    warn.mock.calls.some((c) => typeof c[0] === "string" && (c[0] as string).includes(id));

  async function wipe() {
    await raw.changeRequest.deleteMany({ where: { tenantId } });
    await raw.deliveryMutation.deleteMany({ where: { tenantId } });
    await raw.orderIdempotencyKey.deleteMany({ where: { tenantId } });
    const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
    await raw.stockMovement.deleteMany({ where: { productId } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.routeRunStop.deleteMany({ where: { routeRun: { route: { tenantId } } } });
    await raw.routeRun.deleteMany({ where: { route: { tenantId } } });
    await raw.routeStop.deleteMany({ where: { route: { tenantId } } });
    await raw.route.deleteMany({ where: { tenantId } });
  }

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
        findOpenOrderDraft: async () => null,
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
        releaseWalletPaymentsInTx: async () => undefined,
        voidInvoiceInTx: async () => undefined,
      },
      creditNotes: {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [],
        releaseOrderCreditsInTx: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => false },
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `B297 ${slug}` } })).id;
    operatorUserId = (
      await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
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
        data: { userId: buyer.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
      })
    ).id;
    driverUserId = (
      await raw.user.create({
        data: {
          email: `dr-${run}@example.test`,
          username: `dr-${run}`,
          role: "DRIVER",
          tenantId,
        },
      })
    ).id;
    driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
    categoryId = (
      await raw.trackedCategory.create({
        data: {
          tenantId,
          name: `Excise ${run}`,
          taxType: "EXCISE_PER_UNIT",
          rate: SNAPSHOT_RATE,
          priceIncludesTax: false,
        },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Cigar ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          currentStock: 1000,
          trackedCategoryId: categoryId,
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  beforeEach(async () => {
    warn.mockClear();
    await wipe();
    await raw.trackedCategory.update({ where: { id: categoryId }, data: { rate: SNAPSHOT_RATE } });
    await raw.product.update({ where: { id: productId }, data: { currentStock: 1000 } });
  });

  afterAll(async () => {
    try {
      await wipe();
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.driver.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      warn.mockRestore();
      await _resetLockPoolForTests();
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  it("harness: create() stamps the trio at the rate in force, and the amount follows", async () => {
    const id = await createOrder(12);
    const [l] = await lines(id);
    expect(l).toMatchObject({
      amount: 0.6,
      type: "EXCISE_PER_UNIT",
      rate: SNAPSHOT_RATE,
      includes: false,
    });
    expect(l.trackedCategoryId).toBe(categoryId);
  }, 120_000);

  // ---- caller 1: updateOrderItems ------------------------------------------------------------

  it("updateOrderItems: a note-only edit after a rate raise leaves the line's amount and trio untouched", async () => {
    const id = await createOrder(12);
    await raiseCategoryRate(LIVE_RATE);
    await edit(id, { replaceAll: false, items: [], orderNotes: "leave at the dock" });
    const [l] = await lines(id);
    expect(l.amount).toBe(0.6); // master re-prices at the live rate: 12 x 0.07 = 0.84
    expect(l.rate).toBe(SNAPSHOT_RATE);
  }, 120_000);

  it("updateOrderItems: a quantity edit after a rate raise prices at the SNAPSHOT rate", async () => {
    const id = await createOrder(12);
    const [before] = await lines(id);
    await raiseCategoryRate(LIVE_RATE);
    await edit(id, { replaceAll: false, items: [{ id: before.id, qty: 6 }] });
    const [l] = await lines(id);
    expect(l.qty).toBe(6);
    expect(l.amount).toBe(0.3); // 6 x 0.05, not 6 x 0.07 = 0.42
    expect(l.rate).toBe(SNAPSHOT_RATE);
  }, 120_000);

  // ---- caller 2 + 3: merge and forceConsolidate -----------------------------------------------

  const mergeAuto = () => inTenant(() => orders.mergeAllPendingForCustomer(customerId, {}));
  const mergeForce = () => inTenant(() => orders.forceConsolidateCustomer(customerId));
  const totalTax = async (customer: string) =>
    (await raw.orderItem.findMany({ where: { order: { customerId: customer } } })).reduce(
      (s, r) => s + Number(r.categoryTaxAmount),
      0,
    );

  it("mergeAllPendingForCustomer: the folded line keeps the snapshot rate after a rate raise", async () => {
    await createOrder(10);
    await createOrder(14);
    await raiseCategoryRate(LIVE_RATE);
    await mergeAuto();
    const survivors = await raw.order.findMany({ where: { tenantId } });
    expect(survivors).toHaveLength(1);
    const ls = await lines(survivors[0].id);
    expect(ls.reduce((s, l) => s + l.qty, 0)).toBe(24);
    expect(Math.round((await totalTax(customerId)) * 100) / 100).toBe(1.2); // 24 x 0.05, not 1.68
    for (const l of ls) expect(l.rate).toBe(SNAPSHOT_RATE);
  }, 120_000);

  it("forceConsolidateCustomer: the folded line keeps the snapshot rate after a rate raise", async () => {
    await createOrder(10);
    await createOrder(14);
    await raiseCategoryRate(LIVE_RATE);
    await mergeForce();
    const survivors = await raw.order.findMany({ where: { tenantId } });
    expect(survivors).toHaveLength(1);
    const ls = await lines(survivors[0].id);
    expect(ls.reduce((s, l) => s + l.qty, 0)).toBe(24);
    expect(Math.round((await totalTax(customerId)) * 100) / 100).toBe(1.2);
    for (const l of ls) expect(l.rate).toBe(SNAPSHOT_RATE);
  }, 120_000);

  // ---- caller 4: approveChangeRequestAtStop ---------------------------------------------------

  it("approveChangeRequestAtStop: an approved add keeps pricing the line at its snapshot rate", async () => {
    const id = await createOrder(12);
    const route = await raw.route.create({ data: { name: `r-${run}`, tenantId } as any });
    routeIds.push(route.id);
    const routeStop = await raw.routeStop.create({
      data: { tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
    });
    const rr = await raw.routeRun.create({
      data: {
        tenantId,
        routeId: route.id,
        scheduledDate: new Date("2026-10-12T00:00:00.000Z"),
        status: "IN_PROGRESS" as any,
        driverId,
      },
    });
    const stop = await raw.routeRunStop.create({
      data: {
        tenantId,
        routeRunId: rr.id,
        routeStopId: routeStop.id,
        stopNumber: 1,
        status: "PENDING" as any,
      } as any,
    });
    await raw.order.update({
      where: { id },
      data: { routeRunId: rr.id, routeRunStopId: stop.id },
    });
    const cr = await raw.changeRequest.create({
      data: {
        tenantId,
        orderId: id,
        productId,
        routeRunStopId: stop.id,
        type: "ADD_ITEM" as any,
        payload: { productId, qty: 5 },
      },
    });
    const [original] = await lines(id);
    await raiseCategoryRate(LIVE_RATE);
    await inTenant(() => orders.approveChangeRequestAtStop(cr.id, driver()));
    // the added stock folds into the same product's line (a same-product edit PRESERVES the line's trio)
    const after = await lines(id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: original.id, qty: 17, rate: SNAPSHOT_RATE });
    expect(after[0].amount).toBe(0.85); // 17 x 0.05; master re-prices the whole line: 17 x 0.07 = 1.19
  }, 120_000);

  // ---- NULL trio (legacy line): price at the live rate ONCE, stamp, never again -----------------

  it("a NULL-trio line prices at the live rate once, stamps the trio and warns naming the line", async () => {
    const id = await createOrder(12);
    const [l0] = await lines(id);
    await raw.orderItem.update({
      where: { id: l0.id },
      data: { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null },
    });
    await raiseCategoryRate(LIVE_RATE);
    await edit(id, { replaceAll: false, items: [{ id: l0.id, qty: 6 }] });
    const [l1] = await lines(id);
    expect(l1).toMatchObject({ amount: 0.42, type: "EXCISE_PER_UNIT", rate: LIVE_RATE });
    expect(warnedAbout(l0.id)).toBe(true);

    // stamped: a later raise no longer moves the line
    warn.mockClear();
    await raiseCategoryRate(0.09);
    await edit(id, { replaceAll: false, items: [{ id: l0.id, qty: 3 }] });
    const [l2] = await lines(id);
    expect(l2).toMatchObject({ amount: 0.21, rate: LIVE_RATE });
    expect(warnedAbout(l0.id)).toBe(false);
  }, 120_000);

  it("a partly NULL trio is treated as NULL (one missing column re-stamps the full trio)", async () => {
    const id = await createOrder(12);
    const [l0] = await lines(id);
    await raw.orderItem.update({ where: { id: l0.id }, data: { categoryPriceIncludesTax: null } });
    await raiseCategoryRate(LIVE_RATE);
    await edit(id, { replaceAll: false, items: [{ id: l0.id, qty: 6 }] });
    const [l1] = await lines(id);
    expect(l1).toMatchObject({ amount: 0.42, rate: LIVE_RATE, includes: false });
  }, 120_000);

  // ---- a substitute must not inherit the replaced product's levy ---------------------------------

  it("a pack-line substitute to a non-regulated product drops the replaced product's excise", async () => {
    const plain = await raw.product.create({
      data: {
        name: `Plain ${run}`,
        unit: "each",
        pricePerUnit: "1.00",
        currentStock: 1000,
        tenantId,
      },
    });
    const id = await createOrder(12);
    const [l0] = await lines(id);
    expect(l0.amount).toBe(0.6);
    await edit(id, {
      replaceAll: false,
      items: [{ id: l0.id, substituteProductId: plain.id, qty: 12 }],
    });
    const [l1] = await lines(id);
    expect(l1).toMatchObject({ amount: 0, trackedCategoryId: null, rate: null }); // master: 0; without the fix the old 0.60 survives L1
    // a regulated substitute is priced at its own (stamped-now) trio
    const id2 = await createOrder(12);
    const [m0] = await lines(id2);
    await raiseCategoryRate(LIVE_RATE);
    await edit(id2, {
      replaceAll: false,
      items: [{ id: m0.id, substituteProductId: productId, qty: 10 }],
    });
    const [m1] = await lines(id2);
    expect(m1).toMatchObject({ amount: 0.7, rate: LIVE_RATE }); // a substitute is a new sale at the live rate
    await raw.product.delete({ where: { id: plain.id } }).catch(() => undefined);
  }, 120_000);

  // ---- L1: a line with no category keeps its stored excise -------------------------------------

  it("a no-category line with a stored excise keeps it through a quantity edit, with a warn [L1]", async () => {
    const id = await createOrder(12);
    const [l0] = await lines(id);
    await raw.orderItem.update({
      where: { id: l0.id },
      data: {
        trackedCategoryId: null,
        categoryTaxType: null,
        categoryTaxRate: null,
        categoryPriceIncludesTax: null,
        categoryTaxAmount: 4.2,
      },
    });
    await edit(id, { replaceAll: false, items: [{ id: l0.id, qty: 6 }] });
    const [l1] = await lines(id);
    expect(l1.qty).toBe(6);
    expect(l1.amount).toBe(4.2); // master overwrites it with 0.00
    expect(warnedAbout(l0.id)).toBe(true);
  }, 120_000);
});
