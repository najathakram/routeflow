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

describe("BookkeepingService", () => {
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

    it("REG-B421: totalPaid is cash-only; creditApplied/advanceApplied surface the rest", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        ...MOCK_INVOICE,
        total: 870,
        payments: [
          { amount: 232, status: "PAID", method: "CASH" },
          { amount: 638, status: "PAID", method: "CREDIT_NOTE" },
        ],
      });

      const result: any = await service.findOne("txn-1");

      expect(result.totalPaid).toBe(232);
      expect(result.creditApplied).toBe(638);
      expect(result.advanceApplied).toBe(0);
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
    it("REG-B440-summary: totalRevenue is accrual net sales (gross - creditNotes - externalRefunds), never a paidAt-windowed aggregate", async () => {
      // getSummary now uses invoice/invoicePayment, not transaction/payment
      // B440: gross 500, CN 200, external refund 50 -> net 250 (the same
      // fixture as invoiced-sales.spec.ts's REG-B440-net).
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 500, taxAmount: 0 } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 200 } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 50 } });
      prisma.invoice.findMany.mockResolvedValue([
        { total: 200, payments: [{ amount: 50 }] },
        { total: 300, payments: [{ amount: 100 }] },
      ]);
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 1500 } });
      prisma.invoice.count.mockResolvedValue(3);

      const result = await service.getSummary();

      expect(result.totalRevenue).toBe(250);
      expect(result.grossRevenue).toBe(500);
      expect(result.creditNotes).toBe(200);
      expect(result.externalRefunds).toBe(50);
      expect(result.outstandingReceivables).toBe(350); // (200-50) + (300-100)
      expect(result.paymentsThisWeek).toBe(1500);
      expect(result.overdueCount).toBe(3);

      // B440: revenue is never sourced from a paidAt-windowed aggregate.
      for (const call of prisma.invoice.aggregate.mock.calls) {
        expect(call[0]?.where?.paidAt).toBeUndefined();
      }
    });

    it("should handle empty data gracefully", async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: null, taxAmount: null } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: null } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: null } });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: null } });
      prisma.invoice.count.mockResolvedValue(0);

      const result = await service.getSummary();

      expect(result).toEqual({
        totalRevenue: 0,
        grossRevenue: 0,
        creditNotes: 0,
        externalRefunds: 0,
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
      const cond = args?.include?.payments?.where?.status ?? args?.select?.payments?.where?.status;
      const all: any[] = row._allPayments ?? [];
      const payments = all.filter((p) => {
        if (cond === undefined) return true;
        // F03 narrowed these reads from `{ not: "VOID" }` to the CONFIRMED
        // predicate (`"PAID"`); simulate both shapes so the assertions below
        // still pin NUMBERS rather than a query shape.
        if (typeof cond === "string") return p.status === cond;
        if (cond.not !== undefined) return p.status !== cond.not;
        return true;
      });
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
      // Proves the fix is at the payment level (scoped include), not just invoice
      // status. F03 narrowed the include to the CONFIRMED predicate, which still
      // excludes VOID (it is strictly narrower than `not: VOID`).
      expect(prisma.invoice.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { payments: { where: { status: "PAID" } } },
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
      // The weekly-receipts aggregate must exclude VOID at the payment level —
      // F03's CONFIRMED predicate does that and drops DRAFT as well.
      expect(prisma.invoicePayment.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "PAID" }),
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

    // B443: a credit note applied to an invoice shows up as its own CREDIT_NOTE row
    // AND as the InvoicePayment it created (method CREDIT_NOTE) — same money, two
    // rows, with nothing on the payment row saying they're the same event.
    it("REG-B443 a CREDIT_NOTE-method payment row carries the credit note it applied", async () => {
      prisma.invoicePayment.findMany.mockResolvedValueOnce([
        {
          id: "pay-cn",
          paymentNumber: "PAY-1",
          amount: 40,
          status: "PAID",
          createdAt: new Date("2025-06-01"),
          creditNoteId: "cn-1",
          creditNote: { creditNoteNumber: "CN-2025-0001" },
          invoice: { invoiceNumber: "INV-1", customer: { id: "cust-1", businessName: "Acme" } },
        },
        {
          id: "pay-cash",
          paymentNumber: "PAY-2",
          amount: 25,
          status: "PAID",
          createdAt: new Date("2025-06-02"),
          creditNoteId: null,
          creditNote: null,
          invoice: { invoiceNumber: "INV-2", customer: { id: "cust-1", businessName: "Acme" } },
        },
      ]);

      const result = await service.getReceivableSummary("2025-01-01", "2025-12-31");
      const paymentRows = result.data.filter((r) => r.type === "PAYMENT");

      expect(paymentRows.find((r) => r.transactionNumber === "PAY-1")?.linkedCreditNoteNumber).toBe(
        "CN-2025-0001",
      );
      expect(
        paymentRows.find((r) => r.transactionNumber === "PAY-2")?.linkedCreditNoteNumber,
      ).toBeUndefined();
    });
  });

  // ─── B312: this ledger writer had NO status guard at all — unlike invoices.service's
  // recordPayment (which refuses VOID), a WRITTEN_OFF invoice's `remaining` balance is still
  // > 0 (write-off doesn't touch `total`), so this second, weaker path would happily flip a
  // forgiven invoice back to PARTIAL/PAID as if it were still collectible.
  describe("REG-B312 recordPayment refuses a VOID or WRITTEN_OFF invoice", () => {
    it("refuses a WRITTEN_OFF invoice instead of resurrecting it", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-wo",
        status: "WRITTEN_OFF",
        total: 100,
        payments: [], // remaining = 100 > 0 — the old `remaining <= 0` guard alone can't catch this
      });

      await expect(
        service.recordPayment("inv-wo", { amount: 50, method: "CASH" as any }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("refuses a VOID invoice the same way", async () => {
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-void-2",
        status: "VOID",
        total: 100,
        payments: [],
      });

      await expect(
        service.recordPayment("inv-void-2", { amount: 50, method: "CASH" as any }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });
  });

  // ─── Cash-basis reporting on the settled (bank) date ────────────────────────

  describe("cash-basis reports use settledAt ?? paidAt", () => {
    const FROM = "2026-01-01";
    const TO = "2026-03-31";

    // The Prisma mock does not evaluate `where`, so apply the service's own filter
    // here: a regression back to a plain paidAt window flips these rows' membership.
    const matchesCondition = (value: any, cond: any): boolean => {
      if (cond === null) return value === null;
      if (cond instanceof Date) return value instanceof Date && +value === +cond;
      if (cond && typeof cond === "object") {
        if (cond.gte !== undefined && !(value && value >= cond.gte)) return false;
        if (cond.lte !== undefined && !(value && value <= cond.lte)) return false;
        // B421: RECEIVED_METHOD_FILTER is `{ not: "CREDIT_NOTE" }`.
        if (cond.not !== undefined && value === cond.not) return false;
        return true;
      }
      return value === cond;
    };
    const matchesWhere = (row: any, where: any): boolean =>
      Object.entries(where ?? {}).every(([key, cond]) => {
        if (key === "OR") return (cond as any[]).some((c) => matchesWhere(row, c));
        if (key === "AND") return (cond as any[]).every((c) => matchesWhere(row, c));
        return matchesCondition(row[key], cond);
      });

    const invoiceRel = {
      id: "inv-1",
      invoiceNumber: "INV-0001",
      customerId: "cust-1",
      customer: { id: "cust-1", businessName: "Acme" },
    };
    const payment = (over: Record<string, any>) => ({
      status: "PAID",
      method: "CASH",
      settledAt: null,
      createdAt: new Date("2020-01-01T00:00:00Z"),
      invoice: invoiceRel,
      ...over,
    });

    // Bank date inside the window, instrument recorded before it.
    const SETTLED_IN = payment({
      id: "pay-settled-in",
      amount: 100,
      paidAt: new Date("2025-12-20T00:00:00Z"),
      settledAt: new Date("2026-02-15T00:00:00Z"),
    });
    // Instrument recorded inside the window, money landed before it.
    const SETTLED_OUT = payment({
      id: "pay-settled-out",
      amount: 200,
      paidAt: new Date("2026-02-10T00:00:00Z"),
      settledAt: new Date("2025-12-31T00:00:00Z"),
    });
    // Legacy row: no bank date recorded, so paidAt still decides.
    const LEGACY = payment({
      id: "pay-legacy",
      amount: 300,
      paidAt: new Date("2026-02-01T00:00:00Z"),
    });
    // Post-dated check: clears after the window closes.
    const POST_DATED = payment({
      id: "pay-post-dated",
      amount: 400,
      paidAt: new Date("2026-03-15T00:00:00Z"),
      settledAt: new Date("2026-08-01T00:00:00Z"),
    });
    const VOIDED = payment({
      id: "pay-void",
      amount: 500,
      status: "VOID",
      paidAt: new Date("2026-02-20T00:00:00Z"),
      settledAt: new Date("2026-02-20T00:00:00Z"),
    });

    const ALL = [SETTLED_IN, SETTLED_OUT, LEGACY, POST_DATED, VOIDED];

    beforeEach(() => {
      prisma.invoicePayment.findMany.mockImplementation(async (args: any) =>
        ALL.filter((p) => matchesWhere(p, args.where)),
      );
    });

    it("getCashFlow counts money in on the settled date, keeping legacy rows on paidAt", async () => {
      const result = await service.getCashFlow(FROM, TO);

      // SETTLED_IN (bank date inside) + LEGACY (no bank date, paidAt inside).
      expect(result.totalIn).toBe(400);
    });

    it("REG-B421: a CREDIT_NOTE application never increments totalIn; an ADVANCE application does", async () => {
      const CREDIT_NOTE_APPLIED = payment({
        id: "pay-credit-note",
        amount: 638,
        method: "CREDIT_NOTE",
        paidAt: new Date("2026-02-10T00:00:00Z"),
      });
      const ADVANCE_APPLIED = payment({
        id: "pay-advance",
        amount: 50,
        method: "ADVANCE",
        paidAt: new Date("2026-02-11T00:00:00Z"),
      });
      prisma.invoicePayment.findMany.mockImplementation(async (args: any) =>
        [...ALL, CREDIT_NOTE_APPLIED, ADVANCE_APPLIED].filter((p) => matchesWhere(p, args.where)),
      );

      const result = await service.getCashFlow(FROM, TO);

      // 400 (SETTLED_IN + LEGACY, as above) + 50 (ADVANCE) -- the 638
      // CREDIT_NOTE never lands in totalIn.
      expect(result.totalIn).toBe(450);
    });

    it("getPaymentsReceivedReport includes/excludes rows on the effective date", async () => {
      const result = await service.getPaymentsReceivedReport(FROM, TO);
      const ids = result.data.map((r) => r.id);

      expect(ids).toContain("pay-settled-in");
      expect(ids).toContain("pay-legacy");
      // Money landed before the window even though the instrument was recorded in it.
      expect(ids).not.toContain("pay-settled-out");
      // Post-dated check clears after the window closes.
      expect(ids).not.toContain("pay-post-dated");
      expect(ids).not.toContain("pay-void");
      expect(result.total).toBe(400);
    });

    it("REG-B421: getPaymentsReceivedReport excludes a CREDIT_NOTE row/total, keeps an ADVANCE one", async () => {
      const CREDIT_NOTE_APPLIED = payment({
        id: "pay-credit-note",
        amount: 638,
        method: "CREDIT_NOTE",
        paidAt: new Date("2026-02-10T00:00:00Z"),
      });
      const ADVANCE_APPLIED = payment({
        id: "pay-advance",
        amount: 50,
        method: "ADVANCE",
        paidAt: new Date("2026-02-11T00:00:00Z"),
      });
      prisma.invoicePayment.findMany.mockImplementation(async (args: any) =>
        [...ALL, CREDIT_NOTE_APPLIED, ADVANCE_APPLIED].filter((p) => matchesWhere(p, args.where)),
      );

      const result = await service.getPaymentsReceivedReport(FROM, TO);
      const ids = result.data.map((r) => r.id);

      expect(ids).not.toContain("pay-credit-note");
      expect(ids).toContain("pay-advance");
      // 400 (SETTLED_IN + LEGACY) + 50 (ADVANCE) -- the 638 CREDIT_NOTE never counts.
      expect(result.total).toBe(450);
    });

    it("getPaymentsReceivedReport renders settledAt when present and paidAt otherwise", async () => {
      const result = await service.getPaymentsReceivedReport(FROM, TO);
      const byId = Object.fromEntries(result.data.map((r) => [r.id, r]));

      expect(byId["pay-settled-in"].createdAt).toEqual(SETTLED_IN.settledAt);
      expect(byId["pay-legacy"].createdAt).toEqual(LEGACY.paidAt);
      // Rows come back newest-first on that same effective date.
      expect(result.data.map((r) => r.id)).toEqual(["pay-settled-in", "pay-legacy"]);
    });

    it("matches the old paidAt-only output while no bank dates are recorded anywhere", async () => {
      const legacyRows = ALL.map((p) => ({ ...p, settledAt: null }));
      prisma.invoicePayment.findMany.mockImplementation(async (args: any) =>
        legacyRows.filter((p) => matchesWhere(p, args.where)),
      );

      const result = await service.getPaymentsReceivedReport(FROM, TO);

      // Exactly the PAID rows whose paidAt falls in the window, newest first.
      expect(result.data.map((r) => r.id)).toEqual([
        "pay-post-dated",
        "pay-settled-out",
        "pay-legacy",
      ]);
      expect(result.data.map((r) => r.createdAt)).toEqual([
        POST_DATED.paidAt,
        SETTLED_OUT.paidAt,
        LEGACY.paidAt,
      ]);
    });
  });

  // ─── REG-B11 / T-B11s: dashboard "collected" figures must use the CONFIRMED ──
  // (PAID-only) basis, matching getCashFlow — never `status: { not: "VOID" }`,
  // which silently folds unconfirmed DRAFT payments into money already "in".
  //
  // Fixture: one invoice's payments are PAID $200 (confirmed/cleared) + DRAFT
  // $300 (recorded but not yet confirmed — e.g. a check that hasn't cleared).
  // getCashFlow already sums PAID-only and would report $200 here; these
  // dashboards must report the SAME $200, not $500 (PAID + DRAFT).
  //
  // The same fixture also drives the three reads whose PAYMENTS RELATION the
  // fix narrowed: getMobileDashboard's outstanding select, getFinanceDashboard's
  // AR-aging include, and getPeriodSummary's due include. On a $1,000 invoice the
  // confirmed basis leaves $800 still owed; a `not: "VOID"` relation would net the
  // DRAFT $300 out as well and under-report the balance as $500.
  //
  // NOTE: `getDashboard` (bookkeeping.controller.ts `GET /bookkeeping/dashboard`)
  // is a route alias with no logic of its own — it calls `getMobileDashboard()`
  // directly — so it is exercised transitively by the getMobileDashboard cases
  // below; there is no separate service-level `getDashboard` to test here.
  describe('REG-B11 — dashboard money reads use the CONFIRMED (PAID) basis, not "not: VOID"', () => {
    const NOW = new Date();
    // Simulated DB rows for the one invoice's payments. `paidAt` (not
    // `createdAt`) is the real collected-basis field the aggregates below
    // filter on (check-payments PR-2b/M2: settledAt ?? paidAt); `settledAt`
    // is omitted (legacy row) so the OR's paidAt branch is what matches.
    const FAKE_PAYMENTS = [
      { amount: 200, status: "PAID", method: "CASH", paidAt: NOW },
      { amount: 300, status: "DRAFT", method: "CASH", paidAt: NOW }, // must NOT count as collected
    ];
    // The unpaid invoice those payments sit on, and the balance it must still show.
    const INVOICE_TOTAL = 1000;
    const CONFIRMED_BALANCE = 800; // 1000 - 200 PAID; the not-VOID basis would say 500

    const matchesStatus = (value: string, cond: any): boolean => {
      if (cond === undefined) return true;
      if (typeof cond === "string") return value === cond;
      if (cond.equals !== undefined) return value === cond.equals;
      if (cond.not !== undefined) return value !== cond.not;
      if (cond.in !== undefined) return (cond.in as string[]).includes(value);
      return true;
    };
    const matchesCreatedAt = (value: Date, cond: any): boolean => {
      if (cond === undefined) return true;
      if (cond.gte !== undefined && value < cond.gte) return false;
      if (cond.lte !== undefined && value > cond.lte) return false;
      if (cond.lt !== undefined && value >= cond.lt) return false;
      return true;
    };
    // check-payments PR-2b (M2): the service now filters receipts through
    // `settledDateFilter` — `where: { OR: [{settledAt: <range>}, {settledAt:
    // null, paidAt: <range>}] }` — instead of a bare `where.createdAt` range.
    // A fixture row with no `settledAt` (the legacy-row convention every
    // FAKE_PAYMENTS entry uses) matches through the second OR branch, tested
    // against its `paidAt`.
    const matchesSettledDate = (
      payment: { paidAt: Date; settledAt?: Date | null },
      where: any,
    ): boolean => {
      const cond = where?.OR;
      if (cond !== undefined) {
        return (cond as any[]).some((branch) => {
          if (branch.settledAt === null) {
            return payment.settledAt == null && matchesCreatedAt(payment.paidAt, branch.paidAt);
          }
          return payment.settledAt != null && matchesCreatedAt(payment.settledAt, branch.settledAt);
        });
      }
      // Fallback for a reader that still filters on a plain paidAt/createdAt
      // range instead of settledDateFilter's OR shape.
      if (where?.paidAt !== undefined) return matchesCreatedAt(payment.paidAt, where.paidAt);
      if (where?.createdAt !== undefined) {
        return matchesCreatedAt((payment as any).createdAt ?? payment.paidAt, where.createdAt);
      }
      // Opus review of check-payments PR-2b: neither shape present — the
      // query under test dropped its date filter entirely. Silently
      // matching every row would hide that regression whenever every
      // fixture row happens to share one date; fail loudly instead.
      throw new Error(
        "matchesSettledDate: where clause has neither `OR` (settledDateFilter) nor a plain " +
          "paidAt/createdAt range — the query under test appears to have dropped its date filter",
      );
    };
    // Simulates the real DB: sums FAKE_PAYMENTS honoring whatever `where` the
    // service actually passes, so the assertion pins the resulting NUMBER —
    // not the shape of the query — the same way the cash-basis block above
    // simulates `findMany` filtering for getCashFlow.
    const simulateAggregate = (args: any) => {
      const where = args?.where ?? {};
      const sum = FAKE_PAYMENTS.filter(
        (p) =>
          matchesStatus(p.status, where.status) &&
          // B421: matchesStatus is really a generic Prisma string-filter
          // matcher (plain/equals/not/in) — reused here for `where.method`.
          matchesStatus(p.method, where.method) &&
          matchesSettledDate(p, where),
      ).reduce((s, p) => s + p.amount, 0);
      return { _sum: { amount: sum } };
    };

    // Simulates the invoice reads that carry the predicate on their PAYMENTS
    // RELATION rather than in an aggregate `where`: one unpaid invoice whose
    // payments array honors whatever `where` the service put on the relation.
    // The assertions then pin the resulting BALANCE, so reverting any of those
    // three relations to `not: "VOID"` drops it from $800 to $500.
    const simulateInvoiceFindMany = (args: any) => {
      const relation = args?.include?.payments ?? args?.select?.payments;
      const where = relation && typeof relation === "object" ? relation.where : undefined;
      const payments = FAKE_PAYMENTS.filter((p) => matchesStatus(p.status, where?.status));
      // dueDate null → the AR-aging "current" bucket.
      return [{ id: "inv-b11", total: INVOICE_TOTAL, dueDate: null, payments }];
    };

    beforeEach(() => {
      prisma.invoicePayment.aggregate.mockImplementation(async (args: any) =>
        simulateAggregate(args),
      );
      prisma.invoice.findMany.mockImplementation(async (args: any) =>
        simulateInvoiceFindMany(args),
      );
    });

    it("T-B11s: getMobileDashboard reports totalCollected of $200, not $500 (PAID + DRAFT)", async () => {
      const result = await service.getMobileDashboard();

      expect(result.totalCollected).toBe(200);
      // Pin P-a (B440): `revenue` is no longer `totalCollected` post-fix — its own
      // accrual-net-sales assertion now lives in REG-B440-mobile (T8) below.
    });

    it("REG-B421: totalCollected/paymentsThisWeek/getFinanceDashboard receipts exclude a CREDIT_NOTE, keep an ADVANCE", async () => {
      const withCreditAndAdvance = [
        ...FAKE_PAYMENTS,
        { amount: 638, status: "PAID", method: "CREDIT_NOTE", paidAt: NOW },
        { amount: 50, status: "PAID", method: "ADVANCE", paidAt: NOW },
      ];
      prisma.invoicePayment.aggregate.mockImplementation(async (args: any) => {
        const where = args?.where ?? {};
        const sum = withCreditAndAdvance
          .filter(
            (p) =>
              matchesStatus(p.status, where.status) &&
              matchesStatus(p.method, where.method) &&
              matchesSettledDate(p, where),
          )
          .reduce((s, p) => s + p.amount, 0);
        return { _sum: { amount: sum } };
      });

      // 200 (PAID CASH) + 50 (ADVANCE) = 250. The 638 CREDIT_NOTE and the 300
      // DRAFT never land in any of these three "money received" figures.
      const dashboard = await service.getMobileDashboard();
      expect(dashboard.totalCollected).toBe(250);
      // Pin P-b (B440): `revenue` is no longer `totalCollected` post-fix — its own
      // accrual-net-sales assertion now lives in REG-B440-finance (T9) below.

      const summary = await service.getSummary();
      expect(summary.paymentsThisWeek).toBe(250);

      const finance = await service.getFinanceDashboard();
      expect(finance.monthlySales.totalReceipts).toBe(250);
      expect(finance.summaryTable.today.receipts).toBe(250);
    });

    it("T-B11s: getFinanceDashboard's monthly receipts total $200, not $500 (PAID + DRAFT)", async () => {
      const result = await service.getFinanceDashboard();

      expect(result.monthlySales.totalReceipts).toBe(200);
    });

    it("T-B11s: getFinanceDashboard's summary-table 'today' receipts total $200, not $500 (PAID + DRAFT)", async () => {
      const result = await service.getFinanceDashboard();

      expect(result.summaryTable.today.receipts).toBe(200);
    });

    it("T-B11s: getMobileDashboard's totalOutstanding still owes the DRAFT $300 ($800, not $500)", async () => {
      const result = await service.getMobileDashboard();

      expect(result.totalOutstanding).toBe(CONFIRMED_BALANCE);
    });

    it("T-B11s: getFinanceDashboard's AR aging ages the full $800 balance, not $500", async () => {
      const result = await service.getFinanceDashboard();

      expect(result.arAging.total).toBe(CONFIRMED_BALANCE);
      expect(result.arAging.current).toBe(CONFIRMED_BALANCE);
    });

    it("T-B11s: getFinanceDashboard's summary-table 'today' due balance is $800, not $500", async () => {
      const result = await service.getFinanceDashboard();

      expect(result.summaryTable.today.due).toBe(CONFIRMED_BALANCE);
    });

    // ── check-payments PR-2b (M2): collected basis is settledAt ?? paidAt ────
    // Probe: revert any of the four receipts/totalCollected call sites in
    // this file back to a bare `where.createdAt`/`where.paidAt` range and
    // its matching test below goes red — the settled-outside-window row
    // would then be counted by its paidAt alone. All four sites
    // (getSummary.paymentsThisWeek, getMobileDashboard.totalCollected,
    // getFinanceDashboard's monthly bucket and summary-table period) are
    // covered, one test each, below.

    const mockSettledOutsideWindow = (amount: number) => {
      const future = new Date(NOW);
      future.setFullYear(future.getFullYear() + 1);
      const rows = [{ amount, status: "PAID", method: "CASH", paidAt: NOW, settledAt: future }];
      prisma.invoicePayment.aggregate.mockImplementation(async (args: any) => {
        const where = args?.where ?? {};
        const sum = rows
          .filter(
            (p) =>
              matchesStatus(p.status, where.status) &&
              matchesStatus(p.method, where.method) &&
              matchesSettledDate(p, where),
          )
          .reduce((s, p) => s + p.amount, 0);
        return { _sum: { amount: sum } };
      });
    };

    it("REG-M2-settled: getMobileDashboard.totalCollected excludes a payment settled outside the window, even though its paidAt falls inside it", async () => {
      mockSettledOutsideWindow(200);
      const dashboard = await service.getMobileDashboard();
      expect(dashboard.totalCollected).toBe(0);
    });

    it("REG-M2-settled: getSummary.paymentsThisWeek excludes a payment settled outside the window", async () => {
      mockSettledOutsideWindow(200);
      const summary = await service.getSummary();
      expect(summary.paymentsThisWeek).toBe(0);
    });

    it("REG-M2-settled: getFinanceDashboard's monthly-bucket receipts exclude a payment settled outside the window", async () => {
      mockSettledOutsideWindow(200);
      const result = await service.getFinanceDashboard();
      expect(result.monthlySales.totalReceipts).toBe(0);
    });

    it("REG-M2-settled: getFinanceDashboard's summary-table period receipts exclude a payment settled outside the window", async () => {
      mockSettledOutsideWindow(200);
      const result = await service.getFinanceDashboard();
      expect(result.summaryTable.today.receipts).toBe(0);
    });

    it("REG-M2-parity: a legacy payment with no settledAt is still counted off its paidAt (fixture parity)", async () => {
      // FAKE_PAYMENTS' $200 PAID/CASH row carries paidAt: NOW and no settledAt
      // (the beforeEach default) — this is the exact parity case M2 requires:
      // identical output to the pre-PR-2b paidAt-only basis.
      const dashboard = await service.getMobileDashboard();
      expect(dashboard.totalCollected).toBe(200);
    });

    it("REG-M2-cap: getFinanceDashboard's current-month bucket window is capped at now, not the month's last instant (Opus review of PR-2b)", async () => {
      const calls: any[] = [];
      prisma.invoicePayment.aggregate.mockImplementation(async (args: any) => {
        calls.push(args);
        return simulateAggregate(args);
      });

      await service.getFinanceDashboard();

      const nowInTest = new Date();
      const startOfThisMonth = new Date(nowInTest.getFullYear(), nowInTest.getMonth(), 1);
      const thisMonthCall = calls.find(
        (c) => c.where?.OR?.[0]?.settledAt?.gte?.getTime() === startOfThisMonth.getTime(),
      );
      expect(thisMonthCall).toBeDefined();
      const upperBound: Date = thisMonthCall.where.OR[0].settledAt.lte;
      expect(upperBound.getTime()).toBeLessThanOrEqual(nowInTest.getTime());
      // The uncapped month-end instant is always later than `now` (unless the
      // test happens to run in the month's final millisecond) — proves the
      // cap actually did something, not just that `lte` exists.
      const rawMonthEnd = new Date(
        nowInTest.getFullYear(),
        nowInTest.getMonth() + 1,
        0,
        23,
        59,
        59,
        999,
      );
      expect(upperBound.getTime()).not.toBe(rawMonthEnd.getTime());
    });

    // ── the sibling endpoints in this same file ──────────────────────────────
    // GET /bookkeeping/summary, the AR-aging report and the record-payment guard
    // compute the SAME money as the dashboards above, off the same fixture, and
    // the same operator reads them side by side (apps/web/lib/api/bookkeeping.ts,
    // apps/mobile/lib/api/admin.ts). A DRAFT payment must not make one of them
    // report money the others don't.

    it("T-B11s: getSummary reports paymentsThisWeek $200 / outstanding $800, agreeing with the dashboards", async () => {
      const result = await service.getSummary();

      // On the old `not: VOID` basis: $500 collected this week and $500
      // outstanding — while GET /bookkeeping/dashboard said $200 and $800 for the
      // same tenant, from the same rows.
      expect(result.paymentsThisWeek).toBe(200);
      expect(result.outstandingReceivables).toBe(CONFIRMED_BALANCE);
    });

    it("T-B11s: getArAgingInvoices ages the full $800 balance, not $500", async () => {
      const result = await service.getArAgingInvoices();

      // Same number getFinanceDashboard's AR-aging bucket reports above.
      expect(result.totals.total).toBe(CONFIRMED_BALANCE);
    });

    it("T-B11s: recordPayment sizes the remaining balance from CONFIRMED money only", async () => {
      const create = jest.fn();
      const update = jest.fn().mockResolvedValue({
        id: "inv-b11",
        status: "PARTIAL",
        customerId: "cust-1",
        issueDate: NOW,
        invoiceNumber: "INV-B11",
        total: INVOICE_TOTAL,
        customer: { id: "cust-1", businessName: "Acme" },
        order: null,
        payments: [],
      });
      prisma.tenantTransaction.mockImplementation(async (fn: any) =>
        fn({
          invoice: {
            findUnique: jest.fn(async (args: any) => ({
              id: "inv-b11",
              total: INVOICE_TOTAL,
              payments: FAKE_PAYMENTS.filter((pay) =>
                matchesStatus(pay.status, args?.include?.payments?.where?.status),
              ),
            })),
            update,
          },
          invoicePayment: { create },
        }),
      );

      // $700 fits inside the $800 genuinely still owed. On the old `not: VOID`
      // basis remaining was only $500 and this legitimate payment was rejected.
      await service.recordPayment("inv-b11", { amount: 700, method: "CASH" as any });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 700 }) }),
      );
      // $200 confirmed + $700 new = $900 < $1,000 ⇒ PARTIAL. The DRAFT $300 must
      // not let this write PAID off money nobody has (the lying-status class B74
      // fixes on the invoices side).
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "PARTIAL" }) }),
      );
    });
  });

  // ─── getMobileDashboard (B440) ────────────────────────────────────────────
  // Own fixture (not REG-B11's $200/$300/$800 one) — isolates the accrual-net
  // revenue figure from the cash-basis totalCollected/totalOutstanding ones.

  describe("getMobileDashboard (B440)", () => {
    it("REG-B440-mobile: revenue is accrual net sales, not totalCollected; netIncome subtracts badDebtExpense", async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 500, taxAmount: 0 } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 200 } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 50 } });
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
      prisma.expense.aggregate.mockResolvedValue({ _sum: { amount: 40 } });
      prisma.invoice.findMany.mockImplementation((args: any) => {
        if (args?.where?.writtenOffAt) {
          // balance 300: cash 150 + credit-note-applied 50, same as REG-B456-basis.
          return Promise.resolve([{ total: 500, payments: [{ amount: 150 }, { amount: 50 }] }]);
        }
        return Promise.resolve([]); // outstanding receivables: none
      });

      const result = await service.getMobileDashboard();

      expect(result.revenue).toBe(250);
      expect(result.totalCollected).toBe(100);
      expect(result.revenue).not.toBe(result.totalCollected);
      expect(result.netIncome).toBe(250 - 40 - 300);
    });
  });

  // ─── getFinanceDashboard (B440) ───────────────────────────────────────────

  describe("getFinanceDashboard (B440)", () => {
    it("REG-B440-finance: every sales figure (monthly buckets + summaryTable periods) is the accrual net-sales figure, not the inline gross aggregate", async () => {
      // Harness note (build-plan.md): the 12-month + 5-period-summary calls
      // need a CONSTANT mockResolvedValue (not Once) — every bucket shares
      // this one net-sales fixture (500/200/50 -> net 250).
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 500, taxAmount: 0 } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 200 } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 50 } });
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.expense.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.expense.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockResolvedValue([]); // AR aging / due balances: none

      const result = await service.getFinanceDashboard();

      for (const m of result.monthlySales.data) {
        expect(m.sales).toBe(250);
      }
      expect(result.monthlySales.totalSales).toBe(250 * 12);
      for (const period of ["today", "thisWeek", "thisMonth", "thisQuarter", "thisYear"] as const) {
        expect(result.summaryTable[period].sales).toBe(250);
      }
    });
  });

  // ─── getSalesByCustomer (B440) ────────────────────────────────────────────

  describe("getSalesByCustomer (B440)", () => {
    it("REG-B440-bycustomer: salesAmount is the accrual net (gross - creditNotes - externalRefunds) per customer -- a CN-only customer nets negative, never clamped to 0", async () => {
      // Own fixture: a normal customer (gross 500/CN 200/refund 50 -> net 250,
      // same sentinels as REG-B440-net) and a CN-only customer (gross 0, CN
      // 200, no invoices of its own -> net -200).
      prisma.invoice.groupBy.mockResolvedValue([
        { customerId: "c1", _sum: { total: 500, taxAmount: 0 } },
      ]);
      prisma.creditNote.groupBy.mockResolvedValue([
        { customerId: "c1", _sum: { amount: 200 } },
        { customerId: "c2", _sum: { amount: 200 } },
      ]);
      prisma.return.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { refundAmount: 50 } }]);
      // Defensive: some FIX3 shapes may still read per-invoice rows for
      // invoiceCount/businessName rather than a separate customer lookup.
      prisma.invoice.findMany.mockResolvedValue([
        { customerId: "c1", total: 500, customer: { id: "c1", businessName: "Acme" } },
      ]);
      prisma.customer.findMany.mockResolvedValue([
        { id: "c1", businessName: "Acme" },
        { id: "c2", businessName: "Beta Co" },
      ]);

      const result = await service.getSalesByCustomer("2026-06-01", "2026-06-30");

      const byId = Object.fromEntries(result.data.map((r: any) => [r.customerId, r.salesAmount]));
      expect(byId["c1"]).toBe(250);
      expect(byId["c2"]).toBe(-200);
    });
  });

  // ─── getProfitAndLoss ───────────────────────────────────────────────────────

  describe("getProfitAndLoss", () => {
    const D = (n: number | string) => new Prisma.Decimal(n);

    it("REG-B440-pnl: estimates COGS from the same accrual invoice set as revenue (issueDate, ACCRUAL_REVENUE_STATUSES) -- never PAID/paidAt", async () => {
      // B440: gross 500, CN 200, external refund 50 -> revenue (net) 250 —
      // same fixture as REG-B440-net / REG-B440-summary.
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 500, taxAmount: 0 } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 200 } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 50 } });
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: new Date("2026-06-05"),
          paidAt: new Date("2026-06-20"),
          items: [
            {
              productId: "p1",
              qty: D(5),
              subtotal: D(100),
              product: { name: "Flour", isTobacco: false },
            },
          ],
        },
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { productId: "p1", createdAt: new Date("2026-06-01"), avgCostAfter: D(2) },
      ]);
      prisma.expense.findMany.mockResolvedValue([{ amount: 100, category: { name: "Rent" } }]);

      const result = await service.getProfitAndLoss("2026-06-01", "2026-06-30");

      expect(result.revenue).toBe(250); // net, not gross 500 (this fixture has no WRITTEN_OFF invoice, so badDebtExpense is 0 here — see REG-B456-baddebt)
      expect(result.cogs).toBe(10); // 5 × 2.00
      expect(result.grossProfit).toBe(240); // 250 - 10
      expect(result.operatingExpenses).toBe(100);
      expect(result.netProfit).toBe(140); // 240 - 100
      expect(result.expensesByCategory).toEqual({ Rent: 100 });

      // This INVERTS the pre-B440 pin: the COGS fetch now shares revenue's
      // accrual basis (issueDate/ACCRUAL_REVENUE_STATUSES), never PAID/paidAt.
      const cogsFetch = prisma.invoice.findMany.mock.calls[0][0];
      expect(cogsFetch.where.status).toEqual(ACCRUAL_REVENUE_STATUSES);
      expect(cogsFetch.where.issueDate).toEqual({
        gte: new Date("2026-06-01"),
        lte: expect.any(Date),
      });
      expect(cogsFetch.where.paidAt).toBeUndefined();
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
    });

    it("REG-B456-baddebt: netProfit subtracts badDebtExpense (a WRITTEN_OFF invoice's unpaid balance at write-off); revenue is unaffected by it", async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 500, taxAmount: 0 } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 200 } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 50 } });
      // T5's COGS fixture (10) is replaced with 0 here (no items) to isolate the
      // bad-debt term; a WRITTEN_OFF invoice — issued outside the report window,
      // written off inside it — must be picked up by the badDebtExpense query
      // (which keys on writtenOffAt, never issueDate) but NOT by the COGS query
      // (which keys on issueDate, so it correctly excludes this invoice).
      const writtenOffInvoice = {
        total: 500,
        payments: [{ amount: 150 }, { amount: 50 }], // cash 150 + credit-note-applied 50 -> balance 300
      };
      prisma.invoice.findMany.mockImplementation((args: any) => {
        if (args?.where?.writtenOffAt) return Promise.resolve([writtenOffInvoice]);
        return Promise.resolve([]); // accrual COGS set: empty -> cogs 0
      });
      prisma.expense.findMany.mockResolvedValue([{ amount: 40, category: { name: "Rent" } }]);

      const result = await service.getProfitAndLoss("2026-06-01", "2026-06-30");

      expect(result.revenue).toBe(250); // unaffected by the bad-debt mock
      expect(result.badDebtExpense).toBe(300);
      expect(result.netProfit).toBe(-90); // 250 − 0(cogs) − 40(opEx) − 300(badDebt)
    });

    it("costs each line at the invoice's ISSUE date, even when paid later", async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 100 } });
      // Issued in May (before the report window), paid in June (inside it).
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: new Date("2026-05-15"),
          paidAt: new Date("2026-06-20"),
          items: [
            {
              productId: "p1",
              qty: D(4),
              subtotal: D(100),
              product: { name: "Flour", isTobacco: false },
            },
          ],
        },
      ]);
      // Average cost was 2.00 in May, 3.00 from June 1 — the sale costs at 2.00.
      prisma.stockMovement.findMany.mockResolvedValue([
        { productId: "p1", createdAt: new Date("2026-05-01"), avgCostAfter: D(2) },
        { productId: "p1", createdAt: new Date("2026-06-01"), avgCostAfter: D(3) },
      ]);

      const result = await service.getProfitAndLoss("2026-06-01", "2026-06-30");

      expect(result.cogs).toBe(8); // 4 × 2.00 at issue time, NOT 12 at pay time
    });

    it("rounds COGS to cents (money discipline)", async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 10 } });
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: new Date("2026-06-05"),
          paidAt: new Date("2026-06-06"),
          items: [
            {
              productId: "p1",
              qty: D(3),
              subtotal: D(10),
              product: { name: "Flour", isTobacco: false },
            },
          ],
        },
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { productId: "p1", createdAt: new Date("2026-06-01"), avgCostAfter: D(0.335) },
      ]);

      const result = await service.getProfitAndLoss("2026-06-01", "2026-06-30");

      expect(result.cogs).toBe(1.01); // 3 × 0.335 = 1.005 → cents
    });
  });

  // ─── getBadDebtsReport ────────────────────────────────────────────────────

  describe("getBadDebtsReport", () => {
    it("REG-B456-report: .expense equals the P&L's badDebtExpense for the same window -- both derive from the same fetchBadDebtExpense amount; .total stays the GROSS balance sum the web footer displays (Fable review of #791)", async () => {
      const writtenOffInvoice = {
        id: "inv-wo-1",
        invoiceNumber: "INV-WO-1",
        customer: { id: "cust-1", businessName: "Acme" },
        issueDate: new Date("2026-01-01"),
        dueDate: null,
        writtenOffAt: new Date("2026-06-15"),
        writeOffReason: "uncollectible",
        total: 500,
        // taxAmount 50 makes the pre-tax `expense` (270) diverge from the
        // gross `total` (300) -- proves the two fields are genuinely split,
        // not coincidentally equal.
        taxAmount: 50,
        payments: [{ amount: 150 }, { amount: 50 }], // cash 150 + credit-note-applied 50 -> balance 300
      };
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 0, taxAmount: 0 } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 0 } });
      prisma.invoice.findMany.mockResolvedValue([writtenOffInvoice]);
      prisma.expense.findMany.mockResolvedValue([]);

      const report = await service.getBadDebtsReport();
      const pnl = await service.getProfitAndLoss("2026-06-01", "2026-06-30");

      expect(report.total).toBe(300);
      expect(report.expense).toBe(270);
      expect(pnl.badDebtExpense).toBe(270);
      expect(report.expense).toBe(pnl.badDebtExpense);
      expect(report.total).not.toBe(report.expense);
    });
  });

  // ─── extractExpenseItems (AI receipt extraction) ──────────────────────────

  describe("extractExpenseItems", () => {
    const RECEIPT_MODEL = "claude-opus-4-5-20251101";

    /** `createMockPrisma` predates ExpenseLineItem — graft it onto the object forTenant() returns. */
    const graftExpenseLineItem = () => {
      const model = {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      };
      (prisma as any).expenseLineItem = model;
      (prisma.forTenant() as any).expenseLineItem = model;
      return model;
    };

    beforeEach(() => {
      graftExpenseLineItem();
      prisma.expense.findFirst.mockResolvedValue({
        id: "exp-1",
        receiptKey: "expenses/exp-1/receipt.jpg",
        receiptMimeType: "image/jpeg",
        description: null,
      });
      prisma.expense.update.mockResolvedValue({ id: "exp-1", isItemized: true });
    });

    it("records a tenant-tagged AiUsageEvent with the response's token counts", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              vendor: "Acme",
              total: 12,
              items: [{ description: "Widget", qty: 1, unitCost: 12, amount: 12 }],
            }),
          },
        ],
        usage: { input_tokens: 555, output_tokens: 66 },
      });

      await service.extractExpenseItems("exp-1");

      expect(recordAiUsage).toHaveBeenCalledWith({
        tenantId: "test-tenant",
        feature: "ocr.expense_receipt",
        model: RECEIPT_MODEL,
        inputTokens: 555,
        outputTokens: 66,
      });
    });

    it("records a failed AiUsageEvent and rethrows when the Anthropic call errors", async () => {
      mockAnthropicCreate.mockRejectedValue(new Error("overloaded"));

      await expect(service.extractExpenseItems("exp-1")).rejects.toThrow("overloaded");
      expect(recordAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ feature: "ocr.expense_receipt", success: false }),
      );
    });
  });
});
