/**
 * SA-943 PR-A (W-765 / BC1) — real-Postgres repros for a DATE-ONLY paid date on an instant column, for a tenant in
 * America/Chicago. On master `new Date("YYYY-MM-DD")` stores 00:00Z, which is 19:00 CDT the evening before:
 *  - a payment dated today stores an instant whose tenant-local date is YESTERDAY (master: `<today>T00:00:00.000Z`);
 *  - an office CASH payment on a counter invoice dated today, after the evening close, is refused
 *    DAY_CLOSED_FOR_PAYMENT_DATE (its 00:00Z is before the close's cutoff);
 *  - a past day 10-01 stores 10-01T00:00Z, not the tenant-local start 10-01T05:00Z;
 *  - an edit that resends the shown date (only the reference changed) re-stamps a 21:00 CDT payment to 00:00Z;
 *  - the standalone (allocation) payment dated today lands on yesterday too.
 * Each test fails on master on that wrong value and passes on `paidInstantOf` / `keptPaidInstantOf`.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-sa943-<run>-<n>` slug approved by
 * `assertTestTenant`, deleted in FK order in afterAll.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../orders/orders.service", () => ({ OrdersService: class OrdersService {} }));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { tenantTodayDay } from "../common/calendar-date";
import { _resetLockPoolForTests } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { TILL_ADMIN } from "../testing/till-user";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const MIN = 60_000;
const CHI = "America/Chicago";

describeDb("a date-only paid date for a Chicago tenant, real Postgres (SA-943)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
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
          useValue: {
            sendInvoice: jest.fn(),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        RegulatedLedgerService,
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
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
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
    invoices = mod.get(InvoicesService);
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.counterDayClose.deleteMany(where).catch(swallow);
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.paymentCounter.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenantConfig.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
  });

  /** A throwaway approved Chicago tenant with a $100 SENT invoice on a counter (or ordinary) order. */
  async function seed(label: string, counter: boolean) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa943-${RUN}-${seq}-${label}`,
      "paid-instant-sa943.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `sa943 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    await prisma.tenantConfig.create({ data: { tenantId, timezone: CHI } });
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        status: "DELIVERED",
        fulfillPath: counter ? "PICKUP" : "ROUTE",
        counterSale: counter,
        subtotal: 100,
        tax: 0,
        total: 100,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-SA943-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    return { tenantId, customerId: customer.id, invoiceId: invoice.id };
  }

  const stored = (invoiceId: string) =>
    prisma.invoicePayment.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } });
  const record = (tenantId: string, invoiceId: string, method: string, paidAt: string) =>
    tenantCtx.run(tenantId, () =>
      invoices.recordPayment(invoiceId, { amount: 20, method, paidAt } as any),
    );
  /** What the date box shows the user today: the TENANT's day. */
  const chicagoToday = () => tenantTodayDay(CHI, new Date());

  it("a payment dated TODAY stores an instant whose Chicago date is today (master: <today>T00:00Z, yesterday in Chicago)", async () => {
    const s = await seed("today", false);
    const today = chicagoToday();

    await record(s.tenantId, s.invoiceId, "ACH", today);

    const [row] = await stored(s.invoiceId);
    expect(row.paidAt.toISOString()).not.toBe(`${today}T00:00:00.000Z`);
    expect(tenantTodayDay(CHI, row.paidAt)).toBe(today);
    expect(Math.abs(row.paidAt.getTime() - Date.now())).toBeLessThan(60_000); // "now"
  });

  it("an office CASH payment on a COUNTER invoice dated today, after the evening close, is NOT refused DAY_CLOSED_FOR_PAYMENT_DATE", async () => {
    const s = await seed("after-close", true);
    // The day's close ran 30 min ago (e.g. 19:30 CDT); the office records the cash at 20:00 with today's date.
    const windowEnd = new Date(Date.now() - 30 * MIN);
    await prisma.counterDayClose.create({
      data: {
        tenantId: s.tenantId,
        registerKey: "main",
        day: new Date(),
        zone: CHI,
        windowStart: new Date(windowEnd.getTime() - 600 * MIN),
        windowEnd,
        closedAt: windowEnd,
        expectedCash: 0,
        countedCash: 0,
        variance: 0,
        denominations: [],
        totals: {},
      },
    });

    const res: any = await record(s.tenantId, s.invoiceId, "CASH", chicagoToday()).catch(
      (e: any) => e?.getResponse?.() ?? e,
    );

    expect(res?.code).not.toBe("DAY_CLOSED_FOR_PAYMENT_DATE");
    const [row] = await stored(s.invoiceId);
    expect(row).toBeDefined();
    expect(row.paidAt.getTime()).toBeGreaterThan(windowEnd.getTime()); // after the cutoff: the open day
  });

  it("a PAST day 2026-10-01 stores the Chicago start of that day, 2026-10-01T05:00Z (master: T00:00Z)", async () => {
    const s = await seed("past", false);

    await record(s.tenantId, s.invoiceId, "CHECK", "2026-10-01");

    const [row] = await stored(s.invoiceId);
    expect(row.paidAt.toISOString()).toBe("2026-10-01T05:00:00.000Z");
  });

  it("editing only the reference on a 21:00 CDT payment leaves its instant unchanged (master: re-stamped to 00:00Z)", async () => {
    const s = await seed("edit", false);
    const realTime = "2026-10-22T02:00:00.000Z"; // 21:00 CDT on 10-21
    await record(s.tenantId, s.invoiceId, "ACH", realTime);
    const [before] = await stored(s.invoiceId);
    expect(before.paidAt.toISOString()).toBe(realTime);

    // The edit form resends the date it shows (the tenant-local date of the stored instant) with a new reference.
    await tenantCtx.run(s.tenantId, () =>
      invoices.updatePayment(
        s.invoiceId,
        before.id,
        {
          amount: 20,
          method: "ACH",
          reference: "REF-NEW",
          paidAt: "2026-10-21",
        } as any,
        { user: TILL_ADMIN },
      ),
    );

    const [after] = await stored(s.invoiceId);
    expect(after.reference).toBe("REF-NEW");
    expect(after.paidAt.toISOString()).toBe(realTime);
  });

  it("an edit that moves a past payment (and its settled date) to TODAY stamps the DATABASE clock, not the app clock", async () => {
    const s = await seed("edit-today", false);
    await record(s.tenantId, s.invoiceId, "ACH", "2026-10-01");
    const [before] = await stored(s.invoiceId);
    // Only Date is faked: the app clock reads 2020-01-15 (Chicago midday), timers and the pg socket run as normal.
    const realNow = () => performance.timeOrigin + performance.now();
    jest.useFakeTimers({
      now: new Date("2020-01-15T18:00:00.000Z"),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    try {
      // The edit box sends the business's today by the app clock; the stored instant must come from the DB.
      await tenantCtx.run(s.tenantId, () =>
        invoices.updatePayment(
          s.invoiceId,
          before.id,
          {
            amount: 20,
            method: "ACH",
            paidAt: "2020-01-15",
            settledAt: "2020-01-15",
          } as any,
          { user: TILL_ADMIN },
        ),
      );
    } finally {
      jest.useRealTimers();
    }
    const [after] = await stored(s.invoiceId);
    expect(Math.abs(after.paidAt.getTime() - realNow())).toBeLessThan(60_000); // the app clock would give 2020-01-15T18:00Z
    expect(Math.abs((after.settledAt as Date).getTime() - realNow())).toBeLessThan(60_000);
  });

  it("the standalone (allocation) payment dated today lands on today in Chicago, and a past settledAt on its local start", async () => {
    const s = await seed("standalone", false);
    const today = chicagoToday();

    await tenantCtx.run(s.tenantId, () =>
      invoices.recordStandalonePayment({
        customerId: s.customerId,
        totalAmount: 20,
        method: "ACH",
        paidAt: today,
        settledAt: "2026-10-01",
        allocations: [{ invoiceId: s.invoiceId, amount: 20 }],
      } as any),
    );

    const [row] = await stored(s.invoiceId);
    expect(tenantTodayDay(CHI, row.paidAt)).toBe(today);
    expect(row.settledAt?.toISOString()).toBe("2026-10-01T05:00:00.000Z");
  });
});
