/**
 * SA-1163 (W-1218): a Receivable Summary credit row keeps its face-value Total for a VOID or an expired note, with
 * Balance 0 (guards G1, G2). Balance is receivable-summary-credit.spec.ts's subject; this file pins the Total.
 * Bootstrap copied from that spec. Fixtures are acme-style placeholders.
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

describe("BookkeepingService.getReceivableSummary: credit row Total (SA-1163 W-1218)", () => {
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
          useValue: {
            prepareAiCall: jest.fn().mockResolvedValue({
              key: "test-key",
              source: "routeflow",
              model: "claude-sonnet-5-5",
              tenantId: "test-tenant",
            }),
            requireAiTenant: jest.fn(),
            recordAiUsage,
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

    service = module.get<BookkeepingService>(BookkeepingService);
  });

  const NOW = new Date("2026-09-20T12:00:00.000Z");
  const note = (id: string, extra: Record<string, unknown>) => ({
    id,
    creditNoteNumber: id.toUpperCase(),
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    customer: { id: "cust-1", businessName: "Acme" },
    status: "ISSUED",
    amount: 12.5,
    amountUsed: 0,
    expiresAt: null,
    ...extra,
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    jest.spyOn(prisma, "getTenantId").mockReturnValue("test-tenant");
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoicePayment.findMany.mockResolvedValue([]);
  });
  afterEach(() => jest.useRealTimers());

  // SA-1163 (W-1218) ruling 1: a row's Total is the document's face value for every status; only the Balance column
  // says whether the document still counts. Both rows stay listed (UXG-R1 B7, SA-1057 F-2). Fixed face value 17.25.
  it("G1: a VOID note in the period lists at face value 17.25 with balance 0", async () => {
    prisma.creditNote.findMany.mockResolvedValue([
      note("cn-void", { status: "VOID", amount: 17.25, amountUsed: 0 }),
    ]);
    const res: any = await service.getReceivableSummary("2026-09-01", "2026-09-30");
    const rows = res.data.filter((r: any) => r.type === "CREDIT_NOTE");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transactionNumber: "CN-VOID",
      status: "VOID",
      total: 17.25,
      balance: 0,
    });
  });

  it("G2: an ISSUED note that expired yesterday lists ISSUED, face value 17.25, balance 0", async () => {
    prisma.creditNote.findMany.mockResolvedValue([
      note("cn-expired", {
        amount: 17.25,
        amountUsed: 0,
        expiresAt: new Date("2026-09-19T12:00:00.000Z"),
      }),
    ]);
    const res: any = await service.getReceivableSummary("2026-09-01", "2026-09-30");
    const rows = res.data.filter((r: any) => r.type === "CREDIT_NOTE");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transactionNumber: "CN-EXPIRED",
      status: "ISSUED",
      total: 17.25,
      balance: 0,
    });
  });
});
