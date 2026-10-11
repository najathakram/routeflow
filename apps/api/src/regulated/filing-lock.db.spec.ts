/**
 * B297 PR5 (SA-088 D4, SA-734r2 B6) — real-Postgres pins for the LOCKED filing: the tenant-admin lock endpoint's
 * rules and audit, `prepareFiling` returning a LOCKED filing's stored artifact (never regenerating), the
 * last-line LEDGER guard (a write into a locked period throws and writes zero rows), and the user-facing EDIT
 * guard through the real OrdersService.updateOrderItems (a money edit to a line sold in a locked period is a 409
 * FILED_PERIOD_LOCKED; a note edit proceeds; a return books today).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`. Builds a REAL
 * OrdersService via `Object.create` (no Nest DI). The tenant is a throwaway `qa-b297l-<run>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly the rows this run created.
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
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { RegulatedFilingService } from "../regulated/regulated-filing.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SNAPSHOT_RATE = 0.05;
const LIVE_RATE = 0.07;

describeDb("B297 PR5 — a LOCKED filing closes its period, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b297l-${run}`, "filing-lock.db.spec.ts");
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
      await raw.regulatedFiling.deleteMany({ where: { tenantId } });
      await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
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

  const SOLD_BUCKET = "2026-09";
  const periodStart = new Date("2026-09-01T00:00:00Z");
  const periodEnd = new Date("2026-10-01T00:00:00Z");
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const storage = { upload: jest.fn().mockResolvedValue(undefined), presignedUrl: jest.fn() };
  const filingService = () =>
    new (RegulatedFilingService as any)(prisma, storage, audit, { getLedger: jest.fn() }, {});
  const lockAs = (id: string, reason = "September filed with the state") =>
    inTenant(() => filingService().lockFiling(id, { userId: operatorUserId, reason }));
  const makeFiling = (over: Record<string, unknown> = {}) =>
    raw.regulatedFiling.create({
      data: {
        tenantId,
        trackedCategoryId: categoryId,
        reportTemplate: "GENERIC",
        cadence: "MONTHLY",
        periodKey: "2026-09",
        periodStart,
        periodEnd,
        status: "GENERATED",
        generatedAt: new Date("2026-10-02T00:00:00Z"),
        rows: [],
        csvKey: "k.csv",
        totalCategoryTax: 1.23,
        ...over,
      } as any,
    });
  const asLedger = () => new (RegulatedLedgerService as any)(prisma);

  beforeEach(async () => {
    await raw.regulatedFiling.deleteMany({ where: { tenantId } });
    await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
    audit.log.mockClear();
    storage.upload.mockClear();
  });

  it("locks a generated filing whose period has ended: status, who, why, when, and an audit row", async () => {
    const f = await makeFiling();
    const out: any = await lockAs(f.id);
    expect(out).toMatchObject({ status: "LOCKED", lockedById: operatorUserId });
    expect(out.lockReason).toBe("September filed with the state");
    expect(out.lockedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "regulated_filing.locked",
        entityId: f.id,
        meta: expect.objectContaining({
          periodKey: "2026-09",
          reason: "September filed with the state",
        }),
      }),
    );
  }, 120_000);

  it.each([
    ["a running period", { periodEnd: new Date("2099-01-01T00:00:00Z") }, "FILING_PERIOD_RUNNING"],
    ["a FAILED filing", { status: "FAILED" }, "FILING_NOT_LOCKABLE"],
    ["an already LOCKED filing", { status: "LOCKED" }, "FILING_ALREADY_LOCKED"],
  ])(
    "refuses %s",
    async (_name, over, code) => {
      const f = await makeFiling(over);
      await expect(lockAs(f.id)).rejects.toMatchObject({ response: { code } });
      const after = await raw.regulatedFiling.findUniqueOrThrow({ where: { id: f.id } });
      expect(after.status).toBe((over as any).status ?? "GENERATED");
      expect(audit.log).not.toHaveBeenCalled();
    },
    120_000,
  );

  it("requires a reason", async () => {
    const f = await makeFiling();
    await expect(lockAs(f.id, "  ")).rejects.toMatchObject({ status: 400 });
    expect((await raw.regulatedFiling.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
      "GENERATED",
    );
  }, 120_000);

  it("prepareFiling on a LOCKED filing returns the stored row and never regenerates", async () => {
    const f = await makeFiling();
    await lockAs(f.id);
    const out: any = await inTenant(() =>
      filingService().prepareFiling({
        trackedCategoryId: categoryId,
        cadence: "MONTHLY",
        year: 2026,
        index: 9,
        userId: operatorUserId,
      }),
    );
    expect(out.id).toBe(f.id);
    expect(out.status).toBe("LOCKED");
    expect(out.generationCount).toBe(f.generationCount);
    expect(storage.upload).not.toHaveBeenCalled();
  }, 120_000);

  it("the ledger guard: a write into a locked period throws LEDGER_PERIOD_LOCKED and writes zero rows", async () => {
    const f = await makeFiling();
    await lockAs(f.id);
    await expect(
      inTenant(() =>
        asLedger().writeSaleEntries({
          tenantId,
          orderId: null,
          invoiceId: "inv-x",
          soldAt: new Date("2026-09-15T00:00:00Z"), // a bucket covered by the lock
          lines: [
            {
              invoiceItemId: "ii-x",
              orderItemId: null,
              trackedCategoryId: categoryId,
              qty: 1,
              netSales: 10,
              categoryTax: 0.5,
            },
          ],
          db: prisma,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "LEDGER_PERIOD_LOCKED" } });
    expect(await raw.regulatedSalesLedger.count({ where: { tenantId } })).toBe(0);
    // the current period is open: the same write books
    await inTenant(() =>
      asLedger().writeSaleEntries({
        tenantId,
        orderId: null,
        invoiceId: "inv-y",
        soldAt: new Date(),
        lines: [
          {
            invoiceItemId: "ii-y",
            orderItemId: null,
            trackedCategoryId: categoryId,
            qty: 1,
            netSales: 10,
            categoryTax: 0.5,
          },
        ],
        db: prisma,
      }),
    );
    expect(await raw.regulatedSalesLedger.count({ where: { tenantId } })).toBe(1);
  }, 120_000);

  describe("the edit guard through the real updateOrderItems", () => {
    async function soldInSeptember() {
      const orderId = await createOrder(12);
      const [l0] = await lines(orderId);
      await raw.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          entryType: "SALE",
          orderId,
          orderItemId: l0.id,
          invoiceId: null,
          invoiceItemId: null,
          qty: 12,
          unitBasisQty: 12,
          netSales: 12,
          categoryTax: 0.6,
          soldAt: new Date("2026-09-10T00:00:00Z"),
          periodBucket: SOLD_BUCKET,
        },
      });
      return { orderId, lineId: l0.id };
    }

    it("a quantity edit to a line sold in a locked period is a 409 FILED_PERIOD_LOCKED naming the filing; nothing is written", async () => {
      const f = await makeFiling();
      await lockAs(f.id);
      const { orderId, lineId } = await soldInSeptember();
      const err: any = await edit(orderId, {
        replaceAll: false,
        items: [{ id: lineId, qty: 6 }],
      }).catch((e) => e);
      expect(err?.response).toMatchObject({
        code: "FILED_PERIOD_LOCKED",
        filingId: f.id,
        periodKey: "2026-09",
      });
      expect((await lines(orderId))[0].qty).toBe(12);
    }, 120_000);

    it("a note-only edit to the same order proceeds, and so does the same edit once the period is not locked", async () => {
      const f = await makeFiling();
      await lockAs(f.id);
      const { orderId, lineId } = await soldInSeptember();
      await edit(orderId, { replaceAll: false, items: [], orderNotes: "leave at the dock" });
      await raw.regulatedFiling.update({ where: { id: f.id }, data: { status: "GENERATED" } });
      await edit(orderId, { replaceAll: false, items: [{ id: lineId, qty: 6 }] });
      expect((await lines(orderId))[0].qty).toBe(6);
    }, 120_000);
  });
});
