/**
 * #1529 (B87) / SA-517 PR-A: AR aging used to bucket purely by dueDate and never read the deposit, so
 * an invoice whose deposit was overdue but whose dueDate was still ahead looked simply "current".
 * Each aging row now carries depositAmount / depositDueDate / depositOverdue (the SAME read-time
 * math the invoice list uses — the shared pure helper), and ONE new top-level
 * `depositOverdue: { count, outstanding }` summarises them. Buckets and totals are unchanged: they
 * still age by dueDate and must keep agreeing with the finance dashboard's AR figure. The deposit's
 * "today" is the TENANT's day.
 *
 * Bootstrap copied from overdue-zone-2493.spec.ts. Fixtures are acme-style placeholders.
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

describe("BookkeepingService.getArAgingInvoices — deposit visibility (#1529 / SA-517)", () => {
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
  const zone = (tz: string | null) => {
    jest.spyOn(prisma, "getTenantId").mockReturnValue("test-tenant");
    prisma.tenantConfig.findUnique.mockResolvedValue(tz ? { timezone: tz } : null);
  };
  const inv = (id: string, extra: Record<string, unknown>) => ({
    id,
    invoiceNumber: id.toUpperCase(),
    customer: { id: "cust-1", businessName: "Acme" },
    customerId: "cust-1",
    total: 1000,
    status: "SENT",
    issueDate: new Date("2026-09-01T00:00:00.000Z"),
    depositPercent: null,
    depositDueDate: null,
    payments: [],
    ...extra,
  });
  // 12:00 UTC on 2026-09-20 — every fixture's dueDate is in the future (current bucket).
  const NOW = new Date("2026-09-20T12:00:00.000Z");
  const future = new Date("2026-10-15T00:00:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  });
  afterEach(() => jest.useRealTimers());

  it("#1529: a row carries depositAmount/depositDueDate/depositOverdue; an overdue deposit with a future dueDate stays in CURRENT", async () => {
    zone(null);
    prisma.invoice.findMany.mockResolvedValue([
      inv("inv-dep", {
        dueDate: future,
        depositPercent: 50,
        depositDueDate: new Date("2026-09-10T00:00:00.000Z"),
        payments: [{ amount: 100, status: "PAID" }],
      }),
    ]);
    const result: any = await service.getArAgingInvoices();
    expect(result.buckets.current).toHaveLength(1);
    expect(result.buckets.current[0]).toMatchObject({
      id: "inv-dep",
      balance: 900,
      depositAmount: 500,
      depositOverdue: true,
    });
    expect(result.buckets.current[0].depositDueDate).toEqual(new Date("2026-09-10T00:00:00.000Z"));
  });

  it("#1529: ONE top-level depositOverdue {count, outstanding}; totals keep exactly their bucket keys", async () => {
    zone(null);
    prisma.invoice.findMany.mockResolvedValue([
      // overdue deposit: 50% of 1000 = 500, 100 paid ⇒ 400 outstanding
      inv("inv-a", {
        dueDate: future,
        depositPercent: 50,
        depositDueDate: new Date("2026-09-10T00:00:00.000Z"),
        payments: [{ amount: 100, status: "PAID" }],
      }),
      // overdue deposit: 25% of 1000 = 250, nothing paid ⇒ 250 outstanding
      inv("inv-b", {
        dueDate: future,
        depositPercent: 25,
        depositDueDate: new Date("2026-09-19T00:00:00.000Z"),
      }),
      // deposit met (paid 600 ≥ 500) ⇒ not overdue
      inv("inv-c", {
        dueDate: future,
        depositPercent: 50,
        depositDueDate: new Date("2026-09-10T00:00:00.000Z"),
        payments: [{ amount: 600, status: "PAID" }],
      }),
      // deposit not yet due ⇒ not overdue
      inv("inv-d", {
        dueDate: future,
        depositPercent: 50,
        depositDueDate: new Date("2026-09-30T00:00:00.000Z"),
      }),
      // no deposit at all
      inv("inv-e", { dueDate: future }),
    ]);
    const result: any = await service.getArAgingInvoices();
    expect(result.depositOverdue).toEqual({ count: 2, outstanding: 650 });
    expect(Object.keys(result.totals).sort()).toEqual(
      ["current", "days1_30", "days31_60", "days61_90", "days90plus", "total"].sort(),
    );
    // Buckets/totals unchanged: every row is current by dueDate; the total is Σ balances.
    expect(result.totals.current).toBe(900 + 1000 + 400 + 1000 + 1000);
    expect(result.totals.total).toBe(result.totals.current);
  });

  it("#1529: a row with no deposit carries depositAmount null and depositOverdue false", async () => {
    zone(null);
    prisma.invoice.findMany.mockResolvedValue([inv("inv-e", { dueDate: future })]);
    const result: any = await service.getArAgingInvoices();
    expect(result.buckets.current[0]).toMatchObject({
      depositAmount: null,
      depositDueDate: null,
      depositOverdue: false,
    });
    expect(result.depositOverdue).toEqual({ count: 0, outstanding: 0 });
  });

  it("#1529: the deposit's 'today' is the TENANT's day — due today in LA is not overdue while UTC has rolled over", async () => {
    // 03:00 UTC on 09-21 is 20:00 PDT on 09-20: a deposit due 09-20 is due TODAY in LA (grace),
    // though the UTC day is already the 21st.
    jest.setSystemTime(new Date("2026-09-21T03:00:00.000Z"));
    const due0920 = inv("inv-la", {
      dueDate: future,
      depositPercent: 50,
      depositDueDate: new Date("2026-09-20T00:00:00.000Z"),
    });
    zone(LA);
    prisma.invoice.findMany.mockResolvedValue([due0920]);
    const la: any = await service.getArAgingInvoices();
    expect(la.buckets.current[0].depositOverdue).toBe(false);

    zone(null); // control: in UTC the 20th has ended
    prisma.invoice.findMany.mockResolvedValue([due0920]);
    const utc: any = await service.getArAgingInvoices();
    expect(utc.buckets.current[0].depositOverdue).toBe(true);
  });
});
