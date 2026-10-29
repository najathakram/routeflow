/**
 * SA-1026 Part A (owner answer 2, 2026-10-27): AR aging shows "To collect" to STAFF. Each aging invoice row carries the derived
 * `toCollect` state, and the report names, per customer, the summed balance of its To collect invoices
 * (`toCollectByCustomer`), both from `toCollectState` (invoices/to-collect.ts), never a second rule. The buckets and totals
 * do not move: they still age by dueDate and agree with the finance dashboard.
 *   A-G11: one customer with a TO_COLLECT invoice (balance B) and an ordinary open invoice: the column shows B, the buckets
 *          and totals are the same as with no intent at all.
 *
 * Bootstrap copied from ar-aging-deposit-1529.spec.ts. Fixtures are acme-style placeholders.
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

describe("BookkeepingService AR aging: To collect (SA-1026 A-G11)", () => {
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

  const inv = (id: string, extra: Record<string, unknown>) => ({
    id,
    invoiceNumber: id.toUpperCase(),
    customer: { id: "cust-1", businessName: "Acme" },
    customerId: "cust-1",
    total: 1000,
    status: "SENT",
    issueDate: new Date("2026-09-01T00:00:00.000Z"),
    dueDate: new Date("2026-10-15T00:00:00.000Z"),
    depositPercent: null,
    depositDueDate: null,
    expectedPaymentMethod: null,
    payments: [],
    ...extra,
  });
  const NOW = new Date("2026-09-20T12:00:00.000Z");
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    jest.spyOn(prisma, "getTenantId").mockReturnValue("test-tenant");
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
  });
  afterEach(() => jest.useRealTimers());

  const rows = (withIntent: boolean) => [
    inv("inv-tc", { total: 1000, expectedPaymentMethod: withIntent ? "CHECK" : null }),
    inv("inv-plain", { total: 400 }),
    inv("inv-part", {
      total: 1000,
      status: "PARTIAL",
      expectedPaymentMethod: withIntent ? "CHECK" : null,
      customer: { id: "cust-2", businessName: "Beta" },
      customerId: "cust-2",
      payments: [{ amount: 100, status: "PAID" }],
    }),
  ];

  it("A-G11: the To collect column is the summed balance of each customer's TO_COLLECT invoices; buckets and totals do not move", async () => {
    prisma.invoice.findMany.mockResolvedValue(rows(true));
    const marked: any = await service.getArAgingInvoices();
    prisma.invoice.findMany.mockResolvedValue(rows(false));
    const plain: any = await service.getArAgingInvoices();

    expect(marked.toCollectByCustomer).toEqual([
      { customerId: "cust-1", businessName: "Acme", count: 1, balance: 1000 },
      { customerId: "cust-2", businessName: "Beta", count: 1, balance: 900 },
    ]);
    expect(plain.toCollectByCustomer).toEqual([]);
    expect(marked.totals).toEqual(plain.totals);
    expect(Object.keys(marked.buckets)).toEqual(Object.keys(plain.buckets));
    const row = (r: any, id: string) => r.buckets.current.find((e: any) => e.id === id);
    expect(row(marked, "inv-tc").toCollect).toBe("TO_COLLECT");
    expect(row(marked, "inv-part").toCollect).toBe("TO_COLLECT");
    expect(row(marked, "inv-plain").toCollect).toBe("NONE");
    expect(row(plain, "inv-tc").toCollect).toBe("NONE");
  });

  it("the aging details rows carry the same state", async () => {
    prisma.invoice.findMany.mockResolvedValue(rows(true));
    const res: any = await service.getArAgingDetails();
    const byId = Object.fromEntries(res.data.map((r: any) => [r.id, r.toCollect]));
    expect(byId).toEqual({ "inv-tc": "TO_COLLECT", "inv-plain": "NONE", "inv-part": "TO_COLLECT" });
  });
});
