import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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

describe("BookkeepingService", () => {
  let service: BookkeepingService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoiceService: { getPresignedUrl: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoiceService = { getPresignedUrl: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookkeepingService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceService, useValue: invoiceService },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("https://example.com/file"),
            getSignedUrl: jest.fn().mockResolvedValue("https://example.com/signed"),
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
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(null) },
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

  // ─── findAll ──────────────────────────────────────────────────────────────

  describe("findAll", () => {
    it("should return paginated transactions", async () => {
      prisma.invoice.findMany.mockResolvedValue([MOCK_INVOICE]);
      prisma.invoice.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it("should filter by status", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findAll({ status: "UNPAID" as any, page: 1, limit: 20 });

      // UNPAID maps to { in: [SENT, VIEWED, OVERDUE] } on the invoice.status column
      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: expect.objectContaining({ in: expect.any(Array) }),
          }),
        }),
      );
    });

    it("should filter by customerId", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findAll({ customerId: "cust-1", page: 1, limit: 20 });

      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customerId: "cust-1" }),
        }),
      );
    });

    it("should filter by date range", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValue(0);

      await service.findAll({
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
        page: 1,
        limit: 20,
      });

      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            issueDate: expect.objectContaining({
              gte: expect.any(Date),
              lte: expect.any(Date),
            }),
          }),
        }),
      );
    });
  });

  // ─── findOne ──────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should return a transaction with customer and items", async () => {
      prisma.invoice.findUnique.mockResolvedValue(MOCK_INVOICE);
      const result = await service.findOne("txn-1");
      expect(result.id).toBe("txn-1");
      expect(result.customer).toEqual(MOCK_INVOICE.customer);
    });

    it("should throw NotFoundException when transaction does not exist", async () => {
      prisma.invoice.findUnique.mockResolvedValue(null);
      await expect(service.findOne("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  // ─── recordPayment ────────────────────────────────────────────────────────

  describe("recordPayment", () => {
    it("should throw NotFoundException when transaction does not exist", async () => {
      // recordPayment uses tenantTransaction (not $transaction)
      prisma.tenantTransaction.mockImplementation(async (fn: any) => {
        const tx = {
          invoice: { findUnique: jest.fn().mockResolvedValue(null) },
          transaction: { findUnique: jest.fn().mockResolvedValue(null) },
          invoicePayment: { create: jest.fn() },
          payment: { create: jest.fn() },
        };
        return fn(tx);
      });

      await expect(
        service.recordPayment("nonexistent", { amount: 50, method: "CASH" as any }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getPdfUrl ────────────────────────────────────────────────────────────

  describe("getPdfUrl", () => {
    it("should return url when PDF exists", async () => {
      invoiceService.getPresignedUrl.mockResolvedValue("https://r2.example.com/invoice.pdf");
      const result = await service.getPdfUrl("txn-1");
      expect(result).toEqual({ url: "https://r2.example.com/invoice.pdf" });
    });

    it("should return null when PDF is not yet generated", async () => {
      invoiceService.getPresignedUrl.mockResolvedValue(null);
      const result = await service.getPdfUrl("txn-1");
      expect(result).toBeNull();
    });
  });

  // ─── getSummary ───────────────────────────────────────────────────────────

  describe("getSummary", () => {
    it("should return aggregated financial summary", async () => {
      // getSummary now uses invoice/invoicePayment, not transaction/payment
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 5000 } });
      prisma.invoice.findMany.mockResolvedValue([
        { total: 200, payments: [{ amount: 50 }] },
        { total: 300, payments: [{ amount: 100 }] },
      ]);
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 1500 } });
      prisma.invoice.count.mockResolvedValue(3);

      const result = await service.getSummary();

      expect(result).toEqual({
        totalRevenue: 5000,
        outstandingReceivables: 350, // (200-50) + (300-100)
        paymentsThisWeek: 1500,
        overdueCount: 3,
      });
    });

    it("should handle empty data gracefully", async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: null } });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: null } });
      prisma.invoice.count.mockResolvedValue(0);

      const result = await service.getSummary();

      expect(result).toEqual({
        totalRevenue: 0,
        outstandingReceivables: 0,
        paymentsThisWeek: 0,
        overdueCount: 0,
      });
    });
  });
});
