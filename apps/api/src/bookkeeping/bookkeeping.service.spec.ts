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

  // ─── P5-12: VOID payments must never count as money received ────────────────

  describe("P5-12 — VOID payments excluded from bookkeeping money figures", () => {
    // The Prisma mock does not itself apply relation `where` filters, so we
    // simulate the DB: return an invoice's payments already filtered per the
    // scoped include/select the service passes. This ties each assertion to the
    // service actually excluding VOID — a regressed (unfiltered) query would see
    // the full `_allPayments` set (including the bounced payment) and fail.
    const applyScopedPayments = (row: any, args: any) => {
      const not =
        args?.include?.payments?.where?.status?.not ?? args?.select?.payments?.where?.status?.not;
      const all: any[] = row._allPayments ?? [];
      const payments = not ? all.filter((p) => p.status !== not) : all;
      const { _allPayments, ...rest } = row;
      return { ...rest, payments };
    };

    it("(a) recordPayment: a fully-bounced (VOID) payment leaves the invoice open, so a new payment is NOT rejected as already paid", async () => {
      // Invoice fully "covered" by a single VOID (bounced-check) payment.
      const bouncedInvoice = {
        id: "inv-void",
        customerId: "cust-1",
        invoiceNumber: "INV-VOID",
        status: "OVERDUE" as const,
        issueDate: new Date(),
        total: 100,
        _allPayments: [{ id: "pay-1", amount: 100, status: "VOID" }],
      };

      prisma.invoice.findUnique.mockImplementation(async (args: any) =>
        applyScopedPayments(bouncedInvoice, args),
      );
      prisma.invoice.update.mockResolvedValue({
        id: "inv-void",
        status: "PARTIAL",
        customerId: "cust-1",
        issueDate: new Date(),
        total: 100,
        invoiceNumber: "INV-VOID",
        customer: { id: "cust-1", businessName: "Acme" },
        order: null,
        payments: [{ id: "pay-2", amount: 40, status: "PAID" }],
      });

      // With the VOID payment excluded, alreadyPaid = 0 and remaining = 100,
      // so this must succeed instead of throwing "already fully paid".
      const result = await service.recordPayment("inv-void", {
        amount: 40,
        method: "CASH" as any,
      });

      expect(result.totalOwed).toBe(100);
      // Proves the guard was passed and the new payment was written.
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 40 }) }),
      );
      // Proves the fix is at the payment level (scoped include), not just invoice status.
      expect(prisma.invoice.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { payments: { where: { status: { not: "VOID" } } } },
        }),
      );
    });

    it("(b) getSummary: a VOID payment does not reduce outstanding receivables, and paymentsThisWeek excludes VOID", async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 100 } });
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.invoice.count.mockResolvedValue(0);
      // One OPEN invoice of 100 whose only payment bounced (VOID).
      prisma.invoice.findMany.mockImplementation(async (args: any) => [
        applyScopedPayments({ total: 100, _allPayments: [{ amount: 100, status: "VOID" }] }, args),
      ]);

      const result = await service.getSummary();

      // Full 100 is still outstanding — the bounced payment must not net it out.
      expect(result.outstandingReceivables).toBe(100);
      // The weekly-receipts aggregate must exclude VOID at the payment level.
      expect(prisma.invoicePayment.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { not: "VOID" } }),
        }),
      );
    });

    it("(b') getReceivableSummary: a VOID payment does not reduce the reported invoice balance", async () => {
      const bounced = {
        id: "inv-2",
        invoiceNumber: "INV-2",
        status: "OVERDUE" as const,
        issueDate: new Date(),
        total: 100,
        customer: { id: "cust-1", businessName: "Acme" },
        _allPayments: [{ id: "p", amount: 100, status: "VOID" }],
      };
      prisma.invoice.findMany.mockImplementation(async (args: any) => [
        applyScopedPayments(bounced, args),
      ]);
      // creditNote.findMany and invoicePayment.findMany default to [] in the mock.

      const result = await service.getReceivableSummary("2025-01-01", "2025-12-31");
      const invoiceRow = result.data.find((r) => r.type === "INVOICE");

      expect(invoiceRow?.balance).toBe(100);
    });
  });
});
