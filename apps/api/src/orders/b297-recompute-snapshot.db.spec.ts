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
import { foldMergeItems } from "./merge-items";

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
  let buyerUserId = "";
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
    await raw.stockMovement.deleteMany({ where: { product: { tenantId } } });
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
    buyerUserId = buyer.id;
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
      await raw.productUnit.deleteMany({ where: { tenantId } });
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

  // ---- row 338: a unit-aware same-product edit keeps the category the line was sold under -------

  it("row 338: a same-product edit of a UNIT line whose product left its category keeps its category and its sale-time excise", async () => {
    const unitProduct = await raw.product.create({
      data: {
        name: `Unit ${run}`,
        unit: "each",
        pricePerUnit: "1.00",
        currentStock: 1000,
        trackedCategoryId: categoryId,
        tenantId,
      },
    });
    await raw.productUnit.create({
      data: {
        tenantId,
        productId: unitProduct.id,
        label: "Case",
        factorToBase: 12,
        price: "10.00",
      },
    });
    const created: any = await inTenant(() =>
      orders.create(
        { customerId, items: [{ productId: unitProduct.id, qty: 1, unitLabel: "Case" }] },
        operator(),
        { skipAutoMerge: true },
      ),
    );
    const [l0] = await lines(created.id);
    expect(l0).toMatchObject({ trackedCategoryId: categoryId, amount: 0.6 }); // 1 Case = 12 x 0.05
    // the product leaves its category (a re-categorisation after the sale)
    await raw.product.update({ where: { id: unitProduct.id }, data: { trackedCategoryId: null } });
    await edit(created.id, {
      replaceAll: false,
      items: [{ id: l0.id, qty: 2, unitLabel: "Case" }],
    });
    const [l1] = await lines(created.id);
    expect(l1.qty).toBe(24); // 2 Cases, stored in base pieces
    expect(l1.trackedCategoryId).toBe(categoryId); // master: null
    expect(l1.amount).toBe(1.2); // 2 Cases = 24 x 0.05 at the line's own trio; master: 0.00
    expect(l1.rate).toBe(SNAPSHOT_RATE);
  }, 120_000);

  // ---- row 340: a merge FOLD carries each existing line's own category and trio -----------------

  const fold = (orderId: string, items: any[]) =>
    inTenant(() =>
      orders.updateOrderItems(orderId, { replaceAll: true, items } as any, operator(), {
        isCreateMerge: true,
      }),
    );

  it("row 340: a fold re-creates an existing line at ITS snapshot rate after a rate raise and a re-categorisation", async () => {
    const other = await raw.trackedCategory.create({
      data: { tenantId, name: `Other ${run}`, taxType: "PERCENT_OF_SALE", rate: 0.5 },
    });
    const id = await createOrder(12);
    const [l0] = await lines(id);
    try {
      await raiseCategoryRate(LIVE_RATE);
      await raw.product.update({ where: { id: productId }, data: { trackedCategoryId: other.id } });
      await fold(id, [{ productId, qty: 20, sourceLineId: l0.id }]);
      const [l1] = await lines(id);
      expect(l1.qty).toBe(20);
      expect(l1.trackedCategoryId).toBe(categoryId); // master: the product's current category
      expect(l1.rate).toBe(SNAPSHOT_RATE); // master: stamped from the live category
      expect(l1.amount).toBe(1); // 20 x 0.05 at the line's own trio
    } finally {
      await raw.product.update({
        where: { id: productId },
        data: { trackedCategoryId: categoryId },
      });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { id: other.id } }).catch(() => undefined);
    }
  }, 120_000);

  it("row 340: a fold keeps a NULL-trio legacy line in ITS category and stamps that category's live trio (the product has since left it)", async () => {
    const id = await createOrder(12);
    const [l0] = await lines(id);
    await raw.orderItem.update({
      where: { id: l0.id },
      data: { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null },
    });
    await raw.product.update({ where: { id: productId }, data: { trackedCategoryId: null } });
    try {
      await raiseCategoryRate(LIVE_RATE);
      await fold(id, [{ productId, qty: 20, sourceLineId: l0.id }]);
      const [l1] = await lines(id);
      expect(l1.trackedCategoryId).toBe(categoryId); // the product's current category is none
      expect(l1.rate).toBe(LIVE_RATE); // stamped from the line's own category, once
      expect(l1.amount).toBe(1.4); // 20 x 0.07; without the carry the levy is dropped to 0
    } finally {
      await raw.product.update({
        where: { id: productId },
        data: { trackedCategoryId: categoryId },
      });
    }
  }, 120_000);

  it("row 340 (foldTarget): a scan folded into a line sold at an older rate goes on a NEW live line; the old line keeps its units and trio", async () => {
    const id = await createOrder(12);
    await raiseCategoryRate(0.08);
    const existing = await raw.orderItem.findMany({ where: { orderId: id } });
    const trio = await orders.liveTrioByProduct([productId]);
    const folded = foldMergeItems(existing as any, [{ productId, qty: 8 }], undefined, trio);
    await fold(id, folded.items as any[]);
    const ls = await lines(id);
    expect(ls.map((l) => [l.qty, l.rate, l.amount]).sort()).toEqual(
      [
        [12, SNAPSHOT_RATE, 0.6], // 12 @ 0.05
        [8, 0.08, 0.64], // 8 @ 0.08, a sale made today (master: one line of 20 @ 0.05 = 1.00)
      ].sort(),
    );
  }, 120_000);

  it("row 340 (foldTarget): mergeAllPendingForCustomer does not sum two lines sold at different rates", async () => {
    await createOrder(12);
    await raiseCategoryRate(0.08);
    await createOrder(8);
    await mergeAuto();
    const survivors = await raw.order.findMany({ where: { tenantId } });
    expect(survivors).toHaveLength(1);
    const ls = await lines(survivors[0].id);
    expect(ls.map((l) => [l.qty, l.rate, l.amount]).sort()).toEqual(
      [
        [12, SNAPSHOT_RATE, 0.6],
        [8, 0.08, 0.64],
      ].sort(),
    );
  }, 120_000);

  const buyer = (): JwtPayload =>
    ({
      sub: buyerUserId,
      username: `buyer-${run}`,
      role: "CUSTOMER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;
  const buyerFold = (orderId: string, items: any[]) =>
    inTenant(() => orders.updateOrderItems(orderId, { replaceAll: true, items } as any, buyer()));

  it("row 343: the BUYER cart-submit fold carries an existing line's own category and trio after a rate raise and a re-categorisation", async () => {
    const other = await raw.trackedCategory.create({
      data: { tenantId, name: `Other343 ${run}`, taxType: "PERCENT_OF_SALE", rate: 0.5 },
    });
    const id = await createOrder(12);
    const [l0] = await lines(id);
    try {
      await raiseCategoryRate(LIVE_RATE);
      await raw.product.update({ where: { id: productId }, data: { trackedCategoryId: other.id } });
      await buyerFold(id, [{ productId, qty: 12, sourceLineId: l0.id }]);
      const [l1] = await lines(id);
      expect(l1.trackedCategoryId).toBe(categoryId); // without the fix: the product's current category
      expect(l1.rate).toBe(SNAPSHOT_RATE); // without the fix: stamped from the live category
      expect(l1.amount).toBe(0.6);
    } finally {
      await raw.product.update({
        where: { id: productId },
        data: { trackedCategoryId: categoryId },
      });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { id: other.id } }).catch(() => undefined);
    }
  }, 120_000);

  it("row 343 (foldTarget): the buyer fold puts a scan on a NEW live line when the existing line was sold at an older rate", async () => {
    const id = await createOrder(12);
    await raiseCategoryRate(0.08);
    const existing = await raw.orderItem.findMany({ where: { orderId: id } });
    const trio = await orders.liveTrioByProduct([productId]);
    const folded = foldMergeItems(existing as any, [{ productId, qty: 8 }], undefined, trio);
    await buyerFold(id, folded.items as any[]);
    const ls = await lines(id);
    expect(ls.map((l) => [l.qty, l.rate, l.amount]).sort()).toEqual(
      [
        [12, SNAPSHOT_RATE, 0.6],
        [8, 0.08, 0.64],
      ].sort(),
    );
  }, 120_000);

  it("row 340: a fold keeps a no-category line category-less with its stored levy; a NEW line stamps live", async () => {
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
    await raiseCategoryRate(LIVE_RATE);
    await fold(id, [
      { productId, qty: 12, sourceLineId: l0.id },
      { productId, qty: 5 }, // no sourceLineId: genuinely new, a new sale at the live rate
    ]);
    const ls = await lines(id);
    expect(ls).toHaveLength(2);
    const kept = ls.find((l) => l.qty === 12)!;
    expect(kept).toMatchObject({ trackedCategoryId: null, amount: 4.2, rate: null });
    const added = ls.find((l) => l.qty === 5)!;
    expect(added).toMatchObject({ trackedCategoryId: categoryId, rate: LIVE_RATE });
    expect(added.amount).toBe(0.35);
  }, 120_000);

  // ---- row 352: the buyer's PATCH items edit names its lines (orderItemId) ----------------------

  const buyerEdit = (orderId: string, items: any[], extra: Record<string, unknown> = {}) =>
    inTenant(() =>
      orders.updateOrderItems(orderId, { replaceAll: true, items, ...extra } as any, buyer(), {
        buyerLineIds: true,
      }),
    );
  // The invoice revert commits on its own connection ahead of the edit transaction: a REFUSED edit must
  // never reach it (a SENT invoice reverted to DRAFT with no edit to re-sync it).
  const revertSpy = () => {
    const spy = jest.spyOn(orders.invoicesService, "revertLinkedInvoicesForOrderEdit");
    spy.mockClear(); // a spy from an earlier case keeps its call history
    return spy;
  };
  /** An order holding 12 @ the snapshot rate and 8 @ 0.08: what a row-340 split leaves behind. */
  const splitOrder = async () => {
    const id = await createOrder(12);
    await raiseCategoryRate(0.08);
    const existing = await raw.orderItem.findMany({ where: { orderId: id } });
    const trio = await orders.liveTrioByProduct([productId]);
    const folded = foldMergeItems(existing as any, [{ productId, qty: 8 }], undefined, trio);
    await fold(id, folded.items as any[]);
    const ls = await lines(id);
    return { id, a: ls.find((l) => l.qty === 12)!, b: ls.find((l) => l.qty === 8)! };
  };
  const shape = (ls: Array<{ qty: number; rate: number | null; amount: number }>) =>
    ls.map((l) => [l.qty, l.rate, l.amount]).sort();

  it("row 352: a named line keeps its own category and trio after a rate raise and a re-categorisation", async () => {
    const other = await raw.trackedCategory.create({
      data: { tenantId, name: `Other352 ${run}`, taxType: "PERCENT_OF_SALE", rate: 0.5 },
    });
    const id = await createOrder(12);
    const [l0] = await lines(id);
    try {
      await raiseCategoryRate(LIVE_RATE);
      await raw.product.update({ where: { id: productId }, data: { trackedCategoryId: other.id } });
      await buyerEdit(id, [{ productId, qty: 12, orderItemId: l0.id }]);
      const [l1] = await lines(id);
      expect(l1.trackedCategoryId).toBe(categoryId); // without the id: the product's current category
      expect(l1.rate).toBe(SNAPSHOT_RATE); // without the id: stamped from the live category
      expect(l1.amount).toBe(0.6);
    } finally {
      await raw.product.update({
        where: { id: productId },
        data: { trackedCategoryId: categoryId },
      });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { id: other.id } }).catch(() => undefined);
    }
  }, 120_000);

  it("row 352: more quantity on a line sold at an older rate keeps its units and puts the rest on a live line", async () => {
    const id = await createOrder(12);
    const [l0] = await lines(id);
    await raiseCategoryRate(0.08);
    await buyerEdit(id, [{ productId, qty: 20, orderItemId: l0.id }]);
    expect(shape(await lines(id))).toEqual(
      [
        [12, SNAPSHOT_RATE, 0.6],
        [8, 0.08, 0.64],
      ].sort(),
    );
  }, 120_000);

  it("row 352: more quantity at an unchanged rate stays on the one line", async () => {
    const id = await createOrder(12);
    const [l0] = await lines(id);
    await buyerEdit(id, [{ productId, qty: 20, orderItemId: l0.id }]);
    expect(shape(await lines(id))).toEqual([[20, SNAPSHOT_RATE, 1]]);
  }, 120_000);

  it("row 352: the two lines of a split order round-trip, each at its own rate", async () => {
    const { id, a, b } = await splitOrder();
    await buyerEdit(id, [
      { productId, qty: 12, orderItemId: a.id },
      { productId, qty: 8, orderItemId: b.id },
    ]);
    expect(shape(await lines(id))).toEqual(
      [
        [12, SNAPSHOT_RATE, 0.6],
        [8, 0.08, 0.64],
      ].sort(),
    );
  }, 120_000);

  it("row 352: reducing one line of a split order keeps both rates", async () => {
    const { id, a, b } = await splitOrder();
    await buyerEdit(id, [
      { productId, qty: 12, orderItemId: a.id },
      { productId, qty: 3, orderItemId: b.id },
    ]);
    expect(shape(await lines(id))).toEqual(
      [
        [12, SNAPSHOT_RATE, 0.6],
        [3, 0.08, 0.24],
      ].sort(),
    );
  }, 120_000);

  it("row 352: an entry with no id, beside the line that names the product, is a new line at the live rate", async () => {
    const id = await createOrder(12);
    const [l0] = await lines(id);
    await raiseCategoryRate(0.08);
    await buyerEdit(id, [
      { productId, qty: 12, orderItemId: l0.id },
      { productId, qty: 5 },
    ]);
    expect(shape(await lines(id))).toEqual(
      [
        [12, SNAPSHOT_RATE, 0.6],
        [5, 0.08, 0.4],
      ].sort(),
    );
  }, 120_000);

  it("row 352: an id that is not a line of this order is a 400 and nothing is written", async () => {
    const mine = await createOrder(12);
    const theirs = await createOrder(7);
    const [foreign] = await lines(theirs);
    const before = await lines(mine);
    const revert = revertSpy();
    await expect(
      buyerEdit(mine, [{ productId, qty: 12, orderItemId: foreign.id }]),
    ).rejects.toMatchObject({ status: 400 });
    expect(await lines(mine)).toEqual(before);
    expect(revert).not.toHaveBeenCalled(); // no SENT invoice is un-sent by a refused edit
  }, 120_000);

  it("row 352 (legacy id-less): exactly one line of the product is that line, its trio carried", async () => {
    const id = await createOrder(12);
    await raiseCategoryRate(0.08);
    await buyerEdit(id, [{ productId, qty: 12 }]);
    expect(shape(await lines(id))).toEqual([[12, SNAPSHOT_RATE, 0.6]]);
  }, 120_000);

  it("row 352 (legacy id-less): two lines of the product is a 409 ORDER_EDIT_NEEDS_LINE_IDS and nothing is written", async () => {
    const { id } = await splitOrder();
    const before = await lines(id);
    const revert = revertSpy();
    await expect(buyerEdit(id, [{ productId, qty: 20 }])).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_EDIT_NEEDS_LINE_IDS" }),
    });
    expect(await lines(id)).toEqual(before);
    expect(revert).not.toHaveBeenCalled(); // no SENT invoice is un-sent by a refused edit
  }, 120_000);

  it("row 352 (namesLines): an id-less entry is a NEW line at the live rate even when one line of the product exists", async () => {
    const id = await createOrder(12);
    await raiseCategoryRate(0.08);
    await buyerEdit(id, [{ productId, qty: 12 }], { namesLines: true });
    expect(shape(await lines(id))).toEqual([[12, 0.08, 0.96]]); // a re-added product is a new sale
  }, 120_000);

  it("row 352 (namesLines): two lines removed and the product re-added is a new line, not a 409", async () => {
    const { id } = await splitOrder();
    await buyerEdit(id, [{ productId, qty: 5 }], { namesLines: true });
    expect(shape(await lines(id))).toEqual([[5, 0.08, 0.4]]);
  }, 120_000);

  it("row 352: re-categorised product plus more quantity splits into the NEW category's live line", async () => {
    const other = await raw.trackedCategory.create({
      data: { tenantId, name: `Moved352 ${run}`, taxType: "EXCISE_PER_UNIT", rate: 0.09 },
    });
    const id = await createOrder(12);
    const [l0] = await lines(id);
    try {
      await raw.product.update({ where: { id: productId }, data: { trackedCategoryId: other.id } });
      await buyerEdit(id, [{ productId, qty: 20, orderItemId: l0.id }], { namesLines: true });
      const ls = await lines(id);
      const kept = ls.find((l) => l.qty === 12)!;
      const added = ls.find((l) => l.qty === 8)!;
      expect(kept).toMatchObject({
        trackedCategoryId: categoryId,
        rate: SNAPSHOT_RATE,
        amount: 0.6,
      });
      expect(added).toMatchObject({ trackedCategoryId: other.id, rate: 0.09, amount: 0.72 });
    } finally {
      await raw.product.update({
        where: { id: productId },
        data: { trackedCategoryId: categoryId },
      });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { id: other.id } }).catch(() => undefined);
    }
  }, 120_000);

  it("row 352: a NULL-trio line named by id stamps ITS category's live trio once and keeps it", async () => {
    const id = await createOrder(12);
    const [l0] = await lines(id);
    await raw.orderItem.update({
      where: { id: l0.id },
      data: { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null },
    });
    await raiseCategoryRate(LIVE_RATE);
    await buyerEdit(id, [{ productId, qty: 12, orderItemId: l0.id }]);
    expect(shape(await lines(id))).toEqual([[12, LIVE_RATE, 0.84]]); // priced once at the live rate
  }, 120_000);

  it("row 352: a box-split line named by id compares in pieces and splits at the box boundary", async () => {
    const boxed = await raw.product.create({
      data: {
        name: `Boxed352 ${run}`,
        unit: "each",
        pricePerUnit: "1.00",
        currentStock: 1000,
        unitsPerBox: 12,
        trackedCategoryId: categoryId,
        tenantId,
      },
    });
    const created: any = await inTenant(() =>
      orders.create(
        { customerId, items: [{ productId: boxed.id, qty: 24, boxes: 2, pieces: 0 }] },
        operator(),
        { skipAutoMerge: true },
      ),
    );
    await raw.orderItem.updateMany({ where: { orderId: created.id }, data: { deliveredQty: 0 } });
    await raw.order.update({ where: { id: created.id }, data: { skipAutoMerge: false } });
    const [l0] = await lines(created.id);
    await raiseCategoryRate(0.08);
    await buyerEdit(created.id, [
      { productId: boxed.id, qty: 36, boxes: 3, pieces: 0, orderItemId: l0.id },
    ]);
    expect(shape(await lines(created.id))).toEqual(
      [
        [24, SNAPSHOT_RATE, 1.2],
        [12, 0.08, 0.96],
      ].sort(),
    );
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
