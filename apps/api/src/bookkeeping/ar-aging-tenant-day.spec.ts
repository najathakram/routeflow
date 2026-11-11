/**
 * B331: AR aging buckets count the days past due on the TENANT's calendar day, the same day that decides
 * "overdue" at all (SA-488 `isOverdue`). Both aging reads (getFinanceDashboard's arAging and the AR aging
 * report, getArAgingInvoices) used to compute floor((now - dueDate) / 86400000): a UTC-instant count that
 * is one day too high for a tenant west of UTC in its evening (and one too low for an east-of-UTC tenant
 * in its early morning), which moved a balance across a bucket edge.
 *
 * Bootstrap copied from overdue-zone-2493.spec.ts.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Test, TestingModule } from "@nestjs/testing";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));
jest.mock("./invoice.service", () => ({
  InvoiceService: jest.fn().mockImplementation(() => ({
    generateInvoice: jest.fn(),
    getPresignedUrl: jest.fn(),
  })),
}));
jest.mock("../vendor-bills/vendor-bills.service", () => ({
  VendorBillsService: jest.fn().mockImplementation(() => ({})),
}));

import { BookkeepingService } from "./bookkeeping.service";
import { InvoiceService } from "./invoice.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("B331: AR aging counts days past due on the tenant's calendar day", () => {
  let service: BookkeepingService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
        BookkeepingService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceService, useValue: { getPresignedUrl: jest.fn() } },
        { provide: StorageService, useValue: {} },
        { provide: VendorBillsService, useValue: {} },
        {
          provide: PlatformConfigService,
          useValue: {
            prepareAiCall: jest.fn(),
            requireAiTenant: jest.fn(),
            recordAiUsage: jest.fn(),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();
    service = module.get(BookkeepingService);
    jest.spyOn(prisma, "getTenantId").mockReturnValue("t1");
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 0, taxAmount: 0 } });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 0 } });
    prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    prisma.$queryRaw.mockResolvedValue([{ count: 0 }]);
  });
  afterEach(() => jest.useRealTimers());

  const at = (iso: string) =>
    jest.useFakeTimers({
      now: new Date(iso),
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
  const zone = (tz: string) => prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: tz });
  const invoice = (dueIso: string) => ({
    id: "inv-1",
    invoiceNumber: "INV-1",
    customer: { id: "cust-1", businessName: "Acme" },
    customerId: "cust-1",
    total: 100,
    dueDate: new Date(dueIso),
    status: "SENT",
    issueDate: new Date("2026-10-01T00:00:00.000Z"),
    payments: [],
  });

  // Chicago is UTC-6 in November: 03:00Z on Nov 17 is 21:00 on Nov 16 locally, so the invoice due
  // Nov 1 is 15 tenant days late (bucket 1-15). The UTC-instant count is floor(16.125) = 16.
  const CHICAGO_NOW = "2026-11-17T03:00:00.000Z";

  it("getFinanceDashboard: 15 tenant days late lands in 1-15, not 16-30 (west of UTC, evening)", async () => {
    at(CHICAGO_NOW);
    zone("America/Chicago");
    prisma.invoice.findMany.mockResolvedValue([invoice("2026-11-01T00:00:00.000Z")]);

    const { arAging } = await service.getFinanceDashboard();

    expect(arAging.days1_15).toBe(100);
    expect(arAging.days16_30).toBe(0);
  });

  it("getArAgingInvoices: 15 tenant days late lands in days1_15, not days16_30 (interval 15)", async () => {
    at(CHICAGO_NOW);
    zone("America/Chicago");
    prisma.invoice.findMany.mockResolvedValue([invoice("2026-11-01T00:00:00.000Z")]);

    const result: any = await service.getArAgingInvoices(15);

    expect(result.buckets.days1_15.map((e: any) => e.id)).toEqual(["inv-1"]);
    expect(result.buckets.days16_30).toEqual([]);
  });

  it("getArAgingInvoices: the same invoice with the default 30-day interval stays in days1_30", async () => {
    at(CHICAGO_NOW);
    zone("America/Chicago");
    prisma.invoice.findMany.mockResolvedValue([invoice("2026-11-01T00:00:00.000Z")]);

    const result: any = await service.getArAgingInvoices();

    expect(result.buckets.days1_30.map((e: any) => e.id)).toEqual(["inv-1"]);
  });

  // Tokyo is UTC+9: 20:00Z on Dec 1 is 05:00 on Dec 2 locally, so Nov 1 is 31 tenant days late
  // (second bucket). The UTC-instant count floors to 30 and kept it in the first bucket.
  it("getArAgingInvoices: 31 tenant days late is in the second bucket (east of UTC, early morning)", async () => {
    at("2026-12-01T20:00:00.000Z");
    zone("Asia/Tokyo");
    prisma.invoice.findMany.mockResolvedValue([invoice("2026-11-01T00:00:00.000Z")]);

    const result: any = await service.getArAgingInvoices();

    expect(result.buckets.days31_60.map((e: any) => e.id)).toEqual(["inv-1"]);
    expect(result.buckets.days1_30).toEqual([]);
  });

  it("getFinanceDashboard: 46 tenant days late is in 45+ (east of UTC), not 31-45", async () => {
    // Tokyo 05:00 on Dec 17 (= Dec 16 20:00Z): Nov 1 is 46 tenant days late; the UTC count floors to 45.
    at("2026-12-16T20:00:00.000Z");
    zone("Asia/Tokyo");
    prisma.invoice.findMany.mockResolvedValue([invoice("2026-11-01T00:00:00.000Z")]);

    const { arAging } = await service.getFinanceDashboard();

    expect(arAging.days45plus).toBe(100);
    expect(arAging.days31_45).toBe(0);
  });

  it("getArAgingDetails: ageDays is the tenant-day count (15 in Chicago's evening, not 16)", async () => {
    at(CHICAGO_NOW);
    zone("America/Chicago");
    prisma.invoice.findMany.mockResolvedValue([invoice("2026-11-01T00:00:00.000Z")]);

    const result: any = await service.getArAgingDetails();

    expect(result.data.map((r: any) => r.ageDays)).toEqual([15]);
  });

  it("a UTC tenant is unchanged: the tenant day is the UTC day", async () => {
    at("2026-11-16T21:00:00.000Z");
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    prisma.invoice.findMany.mockResolvedValue([invoice("2026-11-01T00:00:00.000Z")]);

    const { arAging } = await service.getFinanceDashboard();

    expect(arAging.days1_15).toBe(100);
  });

  it("pin: the two aging blocks use the shared tenant-day count, no raw 86400000 maths", () => {
    const src = readFileSync(join(__dirname, "bookkeeping.service.ts"), "utf8");
    const agingLines = src.split(/\r?\n/).filter((l) => /\bconst daysPast\b/.test(l));
    expect(agingLines).toHaveLength(2);
    for (const l of agingLines) {
      expect(l).not.toMatch(/86_?400_?000/);
      expect(l).toContain("daysLateOn(tenantTodayDay(tz, now), inv.dueDate)");
    }
  });
});
