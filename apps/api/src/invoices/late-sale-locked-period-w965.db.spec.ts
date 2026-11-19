/**
 * W-965 / SA-1137 (case table, DB lane): a delivery billed AFTER the month of its (inherited) order date has been
 * LOCKED books the regulated SALE into the CURRENT month with `originalSoldAt` = the order's date. The invoice keeps
 * the order's date; a date chosen at the request is still refused.
 *
 * Real `InvoicesService` + real `RegulatedLedgerService` + real Postgres. The app cannot make a LOCKED filing while
 * `FILING_LOCK_READY` is false, so the LOCKED filing is SEEDED directly (SA-1137 A6, as `filing-lock.db.spec.ts`
 * does). Case 6 drives the real `lockFiling` with the switch mocked open, the way `filing-lock.db.spec.ts` does.
 *
 * Collected only by `jest.db.config.js`; run via `npm run local:test:db`. The tenant is a throwaway `qa-w965-<run>`
 * slug approved by `assertTestTenant`; `afterAll` deletes exactly the rows this file created.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../regulated/filing-lock-ready", () => ({
  ...jest.requireActual("../regulated/filing-lock-ready"),
  assertFilingLockReady: () => undefined, // case 6 drives the real lock; the switch pin lives elsewhere
}));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { RegulatedFilingService } from "../regulated/regulated-filing.service";
import { RegulatedService } from "../regulated/regulated.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { reconcileDeliveredOrdersInTx } from "./delivered-reconcile";
import { settleOrderInvoice } from "../orders/order-status-invoicing";
import { Logger } from "@nestjs/common";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const LATE_SALE_ACTION = "regulated.sale_booked_late";

/** "YYYY-MM" of a UTC date. */
const bucketOf = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

describeDb("W-965 a delivery billed after its month is LOCKED, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let ledger: RegulatedLedgerService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-w965-${run}`, "late-sale-locked-period-w965.db.spec.ts");
  let tenantId = "";
  let customerId = "";
  let userId = "";
  let catK = "";
  let catM = "";
  let prodK = "";
  let prodM = "";

  // The "locked past month": the month before today's, and an order dated the 20th of it.
  const now = new Date();
  const lockedStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lockedEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const LOCKED_BUCKET = bucketOf(lockedStart);
  const CURRENT_BUCKET = bucketOf(now);
  const ORDER_DATE = new Date(
    Date.UTC(lockedStart.getUTCFullYear(), lockedStart.getUTCMonth(), 20),
  );

  const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  const filingStatus = (id: string) =>
    prisma.regulatedFiling.findUniqueOrThrow({ where: { id } }).then((f) => f.status);

  /** A filing for one category's locked month: `LOCKED` (seeded, SA-1137 A6) or `GENERATED`. */
  const makeFiling = (trackedCategoryId: string, status: "LOCKED" | "GENERATED") =>
    prisma.regulatedFiling.create({
      data: {
        tenantId,
        trackedCategoryId,
        reportTemplate: "GENERIC",
        cadence: "MONTHLY",
        periodKey: LOCKED_BUCKET,
        periodStart: lockedStart,
        periodEnd: lockedEnd,
        status,
        rows: [],
        csvKey: "k.csv",
        totalCategoryTax: 0,
        ...(status === "LOCKED"
          ? { lockedAt: new Date(), lockedById: userId, lockReason: "filed with the state" }
          : {}),
      } as any,
    });

  /** An order dated into the locked month, entered while it was open: one line per category passed. */
  async function makeOrder(
    opts: { dated?: boolean; categories?: Array<"K" | "M"> } = {},
  ): Promise<string> {
    const { dated = true, categories = ["K"] } = opts;
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId,
        status: "DELIVERED",
        orderDate: dated ? ORDER_DATE : null,
        deliveredAt: dated ? ORDER_DATE : now,
        hasRegulated: true,
        orderNumber: `W965-${randomUUID().slice(0, 8)}`,
      } as any,
    });
    for (const c of categories) {
      await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: c === "K" ? prodK : prodM,
          name: `Line ${c}`,
          qty: 4,
          deliveredQty: 4,
          unitPrice: 10,
          subtotal: 40,
          trackedCategoryId: c === "K" ? catK : catM,
          categoryTaxType: "EXCISE_PER_UNIT",
          categoryTaxRate: 0.5,
          categoryTaxAmount: 2,
          categoryPriceIncludesTax: false,
        } as any,
      });
    }
    return order.id;
  }

  /** The real filing service over the real ledger reader, so lockFiling's FILING_STALE rebuild is the real one. */
  const filingService = () =>
    new (RegulatedFilingService as any)(
      prisma,
      { upload: jest.fn(), presignedUrl: jest.fn() },
      { log: jest.fn() },
      new RegulatedService(prisma),
      {},
    );

  const saleRows = (orderId: string) =>
    prisma.regulatedSalesLedger.findMany({
      where: { tenantId, orderId, entryType: "SALE" },
      orderBy: { createdAt: "asc" },
    });
  const lateAudits = () =>
    prisma.auditLog.findMany({ where: { tenantId, action: LATE_SALE_ACTION } });

  async function wipeRun() {
    await prisma.regulatedFiling.deleteMany({ where: { tenantId } });
    await prisma.regulatedSalesLedger.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
  }

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    ledger = new RegulatedLedgerService(prisma);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
            set: jest.fn(),
          },
        },
        { provide: RegulatedLedgerService, useValue: ledger }, // the REAL ledger writer
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    invoices = module.get(InvoicesService);

    tenantId = (await prisma.tenant.create({ data: { slug, name: `W965 ${slug}` } })).id;
    await (prisma as any).tenantConfig.create({ data: { tenantId, timezone: "UTC" } });
    const user = await prisma.user.create({
      data: {
        email: `w965-${run}@example.test`,
        username: `w965-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userId = user.id;
    customerId = (
      await prisma.customer.create({
        data: { userId, businessName: "Acme Retail", contactName: "Tester", tenantId },
      })
    ).id;
    const mkCat = (name: string) =>
      prisma.trackedCategory.create({
        data: {
          tenantId,
          name: `${name} ${run}`,
          taxType: "EXCISE_PER_UNIT",
          rate: 0.5,
          priceIncludesTax: false,
        },
      });
    catK = (await mkCat("Excise K")).id;
    catM = (await mkCat("Excise M")).id;
    const mkProd = (name: string, trackedCategoryId: string) =>
      prisma.product.create({
        data: {
          name: `${name} ${run}`,
          unit: "each",
          pricePerUnit: "10.00",
          currentStock: 1000,
          trackedCategoryId,
          tenantId,
        },
      });
    prodK = (await mkProd("Cigar K", catK)).id;
    prodM = (await mkProd("Cigar M", catM)).id;
  }, 120_000);

  beforeEach(wipeRun);

  afterAll(async () => {
    try {
      await wipeRun();
      await prisma.productUnit.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.trackedCategory.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await (prisma as any).tenantConfig.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await prisma?.$disconnect();
    }
  }, 120_000);

  /** The SALE of case 1 as a person sees it: current month, now, the order's date kept as `originalSoldAt`. */
  function expectRouted(row: any) {
    expect(row.periodBucket).toBe(CURRENT_BUCKET);
    expect(row.soldAt.getTime()).toBeGreaterThanOrEqual(now.getTime() - 1000);
    expect(row.originalSoldAt?.toISOString()).toBe(ORDER_DATE.toISOString());
  }

  it("case 1: stop completion (reconcileDeliveredOrdersInTx) books the late sale into the current month; the stop is not rolled back", async () => {
    await makeFiling(catK, "LOCKED");
    const orderId = await makeOrder();
    await inTenant(() =>
      prisma.tenantTransaction((tx: any) =>
        reconcileDeliveredOrdersInTx(
          {
            findOpenOrderDraft: invoices.findOpenOrderDraft.bind(invoices),
            createInvoiceFromOrder: invoices.createInvoiceFromOrder.bind(invoices),
            rebuildIssuedDepositMirrorOnDelivery: (
              invoices as any
            ).rebuildIssuedDepositMirrorOnDelivery.bind(invoices),
            reconcileOrderDeliveredInvoices:
              invoices.reconcileOrderDeliveredInvoices.bind(invoices),
          },
          tx,
          [orderId],
          [orderId],
        ),
      ),
    );
    const invs = await prisma.invoice.findMany({ where: { tenantId, orderId } });
    expect(invs).toHaveLength(1);
    expect(invs[0].issueDate?.toISOString()).toBe(ORDER_DATE.toISOString()); // the invoice keeps the order's date
    const rows = await saleRows(orderId);
    expect(rows).toHaveLength(1);
    expectRouted(rows[0]);
    expect(
      await prisma.regulatedSalesLedger.count({ where: { tenantId, periodBucket: LOCKED_BUCKET } }),
    ).toBe(0);
    const audits = await lateAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({
      invoiceId: invs[0].id,
      categoryId: catK,
      originalPeriod: LOCKED_BUCKET,
      bookedPeriod: CURRENT_BUCKET,
      rows: 1,
    });
  }, 120_000);

  it("case 2: office mark-delivered (settleOrderInvoice) creates the invoice and routes the sale, no error in the result", async () => {
    await makeFiling(catK, "LOCKED");
    const orderId = await makeOrder();
    const result = await inTenant(() =>
      settleOrderInvoice(
        { invoicesService: invoices, prisma } as any,
        orderId,
        new Logger("w965"),
        "delivered",
      ),
    );
    expect(result).toBeUndefined(); // base: ORDER_INVOICE_SETTLE_FAILED after 3 attempts
    expect(await prisma.invoice.count({ where: { tenantId, orderId } })).toBe(1);
    const rows = await saleRows(orderId);
    expect(rows).toHaveLength(1);
    expectRouted(rows[0]);
  }, 120_000);

  it("case 3: POST invoices/from-order (createInvoiceFromOrder) creates the invoice and routes the sale", async () => {
    await makeFiling(catK, "LOCKED");
    const orderId = await makeOrder();
    await inTenant(() => invoices.createInvoiceFromOrder(orderId));
    expect(await prisma.invoice.count({ where: { tenantId, orderId } })).toBe(1);
    const rows = await saleRows(orderId);
    expect(rows).toHaveLength(1);
    expectRouted(rows[0]);
  }, 120_000);

  it("case 4: a K line and an M line, only K's month locked: K routes, M books the order's month, one invoice date", async () => {
    await makeFiling(catK, "LOCKED");
    const orderId = await makeOrder({ categories: ["K", "M"] });
    await inTenant(() => invoices.createInvoiceFromOrder(orderId));
    const invs = await prisma.invoice.findMany({ where: { tenantId, orderId } });
    // observed: a regulated order bills as a base invoice plus a sibling (-R1); every invoice keeps the order's date
    expect(invs.length).toBeGreaterThanOrEqual(1);
    for (const inv of invs) expect(inv.issueDate?.toISOString()).toBe(ORDER_DATE.toISOString());
    const rows = await saleRows(orderId);
    const k = rows.find((r) => r.trackedCategoryId === catK)!;
    const m = rows.find((r) => r.trackedCategoryId === catM)!;
    expectRouted(k);
    expect(m.periodBucket).toBe(LOCKED_BUCKET);
    expect(m.originalSoldAt).toBeNull();
    expect((await lateAudits()).map((a) => (a.meta as any).categoryId)).toEqual([catK]);
  }, 120_000);

  it("case 5 (guard): K's month GENERATED, not locked: the sale books the order's month, not routed; a later lock would refuse FILING_STALE", async () => {
    const filing = await makeFiling(catK, "GENERATED");
    const orderId = await makeOrder();
    await inTenant(() => invoices.createInvoiceFromOrder(orderId));
    const [row] = await saleRows(orderId);
    expect(row.periodBucket).toBe(LOCKED_BUCKET);
    expect(row.originalSoldAt).toBeNull();
    expect(await lateAudits()).toHaveLength(0);
    // the late sale makes the filed figures stale: lockFiling's rebuild refuses it
    const svc = filingService();
    await expect(
      inTenant(() => svc.lockFiling(filing.id, { userId, reason: "Filed with the state" })),
    ).rejects.toMatchObject({ response: { code: "FILING_STALE" } });
    expect(await filingStatus(filing.id)).toBe("GENERATED");
  }, 120_000);

  it("case 13 (guard): another category's filing is LOCKED, K's is GENERATED: K is not routed (the predicate is isLockedFiling, not 'filed')", async () => {
    await makeFiling(catM, "LOCKED"); // anyLockedFiling is true for the tenant
    await makeFiling(catK, "GENERATED");
    const orderId = await makeOrder();
    await inTenant(() => invoices.createInvoiceFromOrder(orderId));
    const [row] = await saleRows(orderId);
    expect(row.periodBucket).toBe(LOCKED_BUCKET);
    expect(row.originalSoldAt).toBeNull();
    expect(await lateAudits()).toHaveLength(0);
  }, 120_000);

  it("case 6a (race, lock first): the lock commits, then the bill routes: never a row in the locked bucket, never a refusal", async () => {
    const filing = await makeFiling(catK, "GENERATED");
    const svc = filingService();
    await inTenant(() => svc.lockFiling(filing.id, { userId, reason: "Filed with the state" }));
    expect(await filingStatus(filing.id)).toBe("LOCKED");
    const orderId = await makeOrder();
    await inTenant(() => invoices.createInvoiceFromOrder(orderId));
    const rows = await saleRows(orderId);
    expect(rows).toHaveLength(1);
    expectRouted(rows[0]);
  }, 120_000);

  it("case 6b (race, bill first): the lock waits for the open bill, then refuses FILING_STALE; the sale never lands in a locked bucket", async () => {
    const filing = await makeFiling(catK, "GENERATED");
    const orderId = await makeOrder();
    const svc = filingService();
    let billed!: () => void;
    const billWritten = new Promise<void>((r) => (billed = r));
    let commit!: () => void;
    const mayCommit = new Promise<void>((r) => (commit = r));
    const bill = inTenant(() =>
      prisma.tenantTransaction(async (tx: any) => {
        await invoices.createInvoiceFromOrder(orderId, tx);
        billed();
        await mayCommit; // the bill's transaction stays open, holding its FOR SHARE on the filing row
      }),
    );
    await billWritten;
    let lockSettled = false;
    const lock = inTenant(() =>
      svc.lockFiling(filing.id, { userId, reason: "Filed with the state" }),
    ).then(
      () => ((lockSettled = true), "locked"),
      (e: any) => ((lockSettled = true), e?.response?.code ?? String(e)),
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(lockSettled).toBe(false); // waiting on the writer's share lock
    commit();
    await bill;
    expect(await lock).toBe("FILING_STALE");
    expect(await filingStatus(filing.id)).toBe("GENERATED");
    const [row] = await saleRows(orderId);
    expect(row.periodBucket).toBe(LOCKED_BUCKET); // booked before the lock: the lock refuses, the person regenerates
  }, 120_000);

  it("case 7 (guard): a manual invoice dated into a locked month is still refused, no rows", async () => {
    await makeFiling(catK, "LOCKED");
    await expect(
      inTenant(() =>
        invoices.create({
          customerId,
          issueDate: ORDER_DATE.toISOString().slice(0, 10),
          items: [
            {
              description: "K line",
              qty: 2,
              unitPrice: 10,
              productId: prodK,
              trackedCategoryId: catK,
            },
          ],
        } as any),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await prisma.regulatedSalesLedger.count({ where: { tenantId } })).toBe(0);
  }, 120_000);

  it("case 9 (guard): an undated order delivered now books the current month, originalSoldAt null, no audit row", async () => {
    await makeFiling(catK, "LOCKED");
    const orderId = await makeOrder({ dated: false });
    await inTenant(() => invoices.createInvoiceFromOrder(orderId));
    const [row] = await saleRows(orderId);
    expect(row.periodBucket).toBe(CURRENT_BUCKET);
    expect(row.originalSoldAt).toBeNull();
    expect(await lateAudits()).toHaveLength(0);
  }, 120_000);

  it("case 10 (guard after the fix): voiding a routed invoice reverses in the current month and leaves the locked month untouched", async () => {
    await makeFiling(catK, "LOCKED");
    const orderId = await makeOrder();
    const [inv]: any = await inTenant(() => invoices.createInvoiceFromOrder(orderId));
    await inTenant(() =>
      invoices.voidInvoice(inv.id, { sub: userId, role: "TENANT_ADMIN", tenantId } as any),
    );
    const all = await prisma.regulatedSalesLedger.findMany({ where: { tenantId, orderId } });
    expect(all.filter((r) => r.periodBucket === LOCKED_BUCKET)).toHaveLength(0);
    const net = all.reduce((n, r) => n + Number(r.netSales), 0);
    expect(net).toBeCloseTo(0, 2);
    expect(all.some((r) => r.entryType === "REVERSAL" && r.periodBucket === CURRENT_BUCKET)).toBe(
      true,
    );
  }, 120_000);
});
