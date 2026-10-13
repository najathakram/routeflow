/**
 * #2493 item 3 / #2518 review (4): bookkeeping's overdue reads resolve the TENANT's zone
 * (TenantConfig.timezone via common/tenant-time-zone.ts) and age on the SA-488 rule — the whole due
 * day is grace in that zone. Forcing the lookup to null (UTC) turns these red: at 20:00 PDT on the
 * due day the UTC day has already ended.
 *
 * Bootstrap copied from bookkeeping.service.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ACCRUAL_REVENUE_STATUSES } from "../common/invoiced-sales";

const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: mockAnthropicCreate } })),
}));

// Mock invoice.service.ts to avoid loading @react-pdf/renderer (ESM-only)
jest.mock("./invoice.service", () => ({
  InvoiceService: jest.fn().mockImplementation(() => ({
    generateInvoice: jest.fn(),
    getPresignedUrl: jest.fn(),
  })),
}));

// Mock VendorBillsService to prevent deep dependency chain
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

const MOCK_TXN = {
  id: "txn-1",
  customerId: "cust-1",
  orderId: "ord-1",
  status: "UNPAID" as const,
  totalOwed: 100,
  totalPaid: 0,
  dueDate: new Date(),
  paidAt: null,
  notes: null,
  pdfUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Invoice row matching what BookkeepingService.findAll / findOne expect back
// from Prisma (the service maps invoices into the transaction-shaped response).
const MOCK_INVOICE = {
  id: "txn-1",
  customerId: "cust-1",
  invoiceNumber: "INV-0001",
  status: "SENT" as const,
  issueDate: new Date(),
  total: 100,
  customer: { id: "cust-1", businessName: "Acme" },
  order: { id: "ord-1", orderNumber: "ORD-0001", status: "DELIVERED" },
  payments: [],
};

describe("BookkeepingService — overdue ages in the tenant zone (#2493/SA-488)", () => {
  let service: BookkeepingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoiceService: { getPresignedUrl: jest.Mock };
  let recordAiUsage: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoiceService = { getPresignedUrl: jest.fn() };
    recordAiUsage = jest.fn();
    mockAnthropicCreate.mockReset();

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
        { provide: InvoiceService, useValue: invoiceService },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("https://example.com/file"),
            getSignedUrl: jest.fn().mockResolvedValue("https://example.com/signed"),
            download: jest.fn().mockResolvedValue(Buffer.from("receipt-bytes")),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: VendorBillsService,
          useValue: {
            createFromExpense: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PlatformConfigService,
          useValue: { resolveAnthropicKey: jest.fn().mockResolvedValue("test-key"), recordAiUsage },
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

    service = module.get<BookkeepingService>(BookkeepingService);
  });

  const LA = "America/Los_Angeles";
  const due = new Date("2026-09-25T00:00:00.000Z");
  const eveningOfDueDayLA = new Date("2026-09-26T03:00:00.000Z"); // 20:00 PDT on the due day
  const openInvoice = {
    id: "inv-1",
    invoiceNumber: "INV-1",
    customer: { id: "cust-1", businessName: "Acme" },
    customerId: "cust-1",
    total: 100,
    dueDate: due,
    status: "SENT",
    issueDate: new Date("2026-09-01T00:00:00.000Z"),
    payments: [],
  };
  const zone = (tz: string | null) => {
    jest.spyOn(prisma, "getTenantId").mockReturnValue("test-tenant");
    prisma.tenantConfig.findUnique.mockResolvedValue(tz ? { timezone: tz } : null);
  };

  beforeEach(() => {
    jest.useFakeTimers({
      now: eveningOfDueDayLA,
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
  });
  afterEach(() => jest.useRealTimers());

  it("AR aging: an LA tenant's invoice is still CURRENT at 20:00 local on its due day", async () => {
    zone(LA);
    prisma.invoice.findMany.mockResolvedValue([openInvoice]);
    const result: any = await service.getArAgingInvoices();
    expect(result.buckets.current.map((e: any) => e.id)).toEqual(["inv-1"]);
    expect(result.buckets.days1_30).toEqual([]);
  });

  it("AR aging control: with no tenant zone (UTC) the same instant ages it as overdue", async () => {
    zone(null);
    prisma.invoice.findMany.mockResolvedValue([openInvoice]);
    const result: any = await service.getArAgingInvoices();
    expect(result.buckets.current).toEqual([]);
    expect(result.buckets.days1_30.map((e: any) => e.id)).toEqual(["inv-1"]);
  });

  it("summary's overdue count uses the tenant's day as its cutoff", async () => {
    zone(LA);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([{ count: 0 }]);
    await service.getSummary().catch(() => undefined);
    // SA-770: the count is the balance-due SQL; the cutoff rides as a bound value.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const { values } = prisma.$queryRaw.mock.calls[0][0] as { values: unknown[] };
    // The LA tenant's today is still Sep 25, so only invoices due BEFORE Sep 25 count.
    expect(values).toContain(due.toISOString());
  });
});
