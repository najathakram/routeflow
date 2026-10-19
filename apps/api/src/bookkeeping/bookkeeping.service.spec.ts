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

  describe("recordPayment — B812: alreadyPaid/remaining/totalPaid are rounded, so a fully-paid invoice actually flips to PAID", () => {
    // 0.70 + 0.10 === 0.7999999999999999 in plain JS float addition — an
    // $0.80 invoice with a $0.70 payment already on it never reached PAID
    // when this $0.10 payment landed, and (B812) every payment after that
    // was refused as "exceeds remaining balance" off a near-zero float
    // residual instead of the correct "already fully paid".
    function mockInvoice(existingPayments: Array<{ amount: number }>) {
      const update = jest.fn().mockResolvedValue({ id: "inv-b812" });
      const create = jest.fn();
      prisma.tenantTransaction.mockImplementation(async (fn: any) =>
        fn({
          $executeRaw: jest.fn(), // SA-404f F1: lockInvoicesForPayment
          invoice: {
            findMany: jest.fn(async () => []),
            findUnique: jest
              .fn()
              .mockResolvedValue({ id: "inv-b812", total: 0.8, payments: existingPayments }),
            update,
          },
          invoicePayment: { create },
        }),
      );
      return { update, create };
    }

    it("REG-B812: a $0.10 payment on a $0.70-already-paid $0.80 invoice flips status to PAID, not PARTIAL", async () => {
      const { update } = mockInvoice([{ amount: 0.7 }]);

      await service.recordPayment("inv-b812", { amount: 0.1, method: "CASH" as any });

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "PAID" }) }),
      );
    });

    it("REG-B812: a further payment on that now-fully-paid invoice is refused as already paid, not as an overpayment", async () => {
      mockInvoice([{ amount: 0.7 }, { amount: 0.1 }]);

      await expect(
        service.recordPayment("inv-b812", { amount: 0.01, method: "CASH" as any }),
      ).rejects.toThrow("Transaction is already fully paid");
    });
  });

  describe("recordPayment — SA-121: dto.amount is rounded to the cent", () => {
    it("a sub-cent amount (10.005) is stored cent-exact, not silently truncated", async () => {
      const create = jest.fn();
      prisma.tenantTransaction.mockImplementation(async (fn: any) =>
        fn({
          $executeRaw: jest.fn(), // SA-404f F1: lockInvoicesForPayment
          invoice: {
            findMany: jest.fn(async () => []),
            findUnique: jest.fn().mockResolvedValue({ id: "inv-sa121", total: 100, payments: [] }),
            update: jest.fn().mockResolvedValue({ id: "inv-sa121" }),
          },
          invoicePayment: { create },
        }),
      );

      await service.recordPayment("inv-sa121", { amount: 10.005, method: "CASH" as any });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 10.01 }) }),
      );
    });
  });

  describe("recordPayment", () => {
    it("should throw NotFoundException when transaction does not exist", async () => {
      // recordPayment uses tenantTransaction (not $transaction)
      prisma.tenantTransaction.mockImplementation(async (fn: any) => {
        const tx = {
          $executeRaw: jest.fn(), // SA-404f F1: lockInvoicesForPayment
          invoice: {
            findMany: jest.fn(async () => []),
            findUnique: jest.fn().mockResolvedValue(null),
          },
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

  describe("recordPayment — SA-404f F1: lock (Order →) Invoice BEFORE reading its status", () => {
    it("takes the Invoice row lock first, so a committed VOID is seen and refused, never written over", async () => {
      const log: string[] = [];
      prisma.tenantTransaction.mockImplementation(async (fn: any) =>
        fn({
          $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
            log.push(strings.join("?").includes('"Order"') ? "lock Order" : "lock Invoice");
          }),
          invoice: {
            findMany: jest.fn(async () => [{ orderId: "ord-1" }]),
            findUnique: jest.fn(async () => {
              log.push("read status");
              return { id: "inv-v", status: "VOID", total: 50, payments: [] };
            }),
            update: jest.fn(),
          },
          invoicePayment: { create: jest.fn() },
        }),
      );
      await expect(
        service.recordPayment("inv-v", { amount: 10, method: "CASH" as any }),
      ).rejects.toThrow("Cannot record a payment on a voided invoice.");
      expect(log).toEqual(["lock Order", "lock Invoice", "read status"]);
    });
  });

  describe("recordPayment — G4: a counter invoice joins the end-of-day close like the office door", () => {
    const DB_NOW = new Date("2026-10-09T17:30:00.000Z");
    const CLOSE_END = new Date("2026-10-09T17:00:00.000Z");

    function setup(opts: { counter: boolean; closeEnd?: Date; dbNow?: Date }) {
      const log: string[] = [];
      const create = jest.fn(async () => ({ id: "pay-1" }));
      // counterPay.scope reads the order through forTenant() BEFORE the transaction.
      prisma.forTenant.mockReturnValue({
        order: {
          findFirst: jest.fn(async () =>
            opts.counter ? { counterSale: true, registerKey: "r1" } : null,
          ),
        },
      } as never);
      prisma.tenantTransaction.mockImplementation(async (fn: any) =>
        fn({
          $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
            const q = strings.join("?");
            log.push(
              q.includes("counter-close")
                ? "lock close"
                : q.includes('"Order"')
                  ? "lock Order"
                  : "lock Invoice",
            );
          }),
          $queryRaw: jest.fn(async () => {
            log.push("db clock");
            return [{ now: opts.dbNow ?? DB_NOW }];
          }),
          counterDayClose: {
            // The latest-standing-close read answers with its windowEnd; the closed-window question (assertOpen: is this
            // instant inside a window?) is answered from the same close, whose window ends at closeEnd.
            findFirst: jest.fn(async ({ where }: any) => {
              if (!opts.closeEnd) return null;
              if (where?.windowEnd?.gt)
                return where.windowEnd.gt < opts.closeEnd ? { id: "close" } : null;
              return { windowEnd: opts.closeEnd };
            }),
          },
          invoice: {
            findMany: jest.fn(async () => [{ orderId: "ord-1" }]),
            findUnique: jest.fn(async () => ({
              id: "inv-c",
              orderId: "ord-1",
              status: "SENT",
              total: 100,
              payments: [],
            })),
            update: jest.fn().mockResolvedValue({ id: "inv-c" }),
          },
          invoicePayment: { create },
        }),
      );
      return { log, create };
    }

    it("counter invoice: the shared close lock is the FIRST statement and paidAt is the database clock", async () => {
      const { log, create } = setup({ counter: true });
      const fixedApp = new Date("2020-01-01T00:00:00.000Z");
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }).setSystemTime(fixedApp);
      try {
        await service.recordPayment("inv-c", { amount: 10, method: "CASH" as any });
      } finally {
        jest.useRealTimers();
      }
      expect(log[0]).toBe("lock close");
      expect(log.slice(0, 3)).toEqual(["lock close", "lock Order", "lock Invoice"]);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paidAt: DB_NOW }) }),
      );
    });

    it("counter invoice: CASH dated before a standing close is refused DAY_CLOSED_FOR_PAYMENT_DATE and nothing is created", async () => {
      // the DB clock reads BEFORE the standing close's cutoff, so the row would land inside a closed window
      const { create } = setup({
        counter: true,
        closeEnd: CLOSE_END,
        dbNow: new Date("2026-10-09T16:00:00.000Z"),
      });
      await expect(
        service.recordPayment("inv-c", { amount: 10, method: "CASH" as any }),
      ).rejects.toMatchObject({ response: { code: "DAY_CLOSED_FOR_PAYMENT_DATE" } });
      expect(create).not.toHaveBeenCalled();
    });

    it("counter invoice: a CHECK dated AFTER the standing close's cutoff is accepted", async () => {
      const { create } = setup({
        counter: true,
        closeEnd: CLOSE_END,
        dbNow: new Date("2026-10-09T18:00:00.000Z"), // the database clock, after windowEnd
      });
      await service.recordPayment("inv-c", { amount: 10, method: "CHECK" as any });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("counter invoice: a CHECK whose date falls INSIDE the closed window is refused (a check moves the closed Z's money in)", async () => {
      const { create } = setup({
        counter: true,
        closeEnd: CLOSE_END,
        dbNow: new Date("2026-10-09T16:00:00.000Z"), // before windowEnd: inside the closed day
      });
      await expect(
        service.recordPayment("inv-c", { amount: 10, method: "CHECK" as any }),
      ).rejects.toMatchObject({ response: { code: "COUNTER_SALE_DAY_CLOSED" } });
      expect(create).not.toHaveBeenCalled();
    });

    it("non-counter invoice: no close lock, no DB clock read, app-clock paidAt, behaviour unchanged", async () => {
      const { log, create } = setup({ counter: false });
      const fixedApp = new Date("2020-01-01T00:00:00.000Z");
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }).setSystemTime(fixedApp);
      try {
        await service.recordPayment("inv-c", { amount: 10, method: "CASH" as any });
      } finally {
        jest.useRealTimers();
      }
      expect(log).toEqual(["lock Order", "lock Invoice"]);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paidAt: fixedApp }) }),
      );
    });
  });

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
        { total: 200, payments: [{ amount: 50, status: "PAID" }] },
        { total: 300, payments: [{ amount: 100, status: "PAID" }] },
      ]);
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 1500 } });
      prisma.$queryRaw.mockResolvedValue([{ count: 3 }]); // SA-770: the overdue count is the balance-due SQL

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
      prisma.$queryRaw.mockResolvedValue([{ count: 0 }]);

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

    it("SA-770: overdueCount counts invoices with a BALANCE DUE � tenant-scoped, bound, never invoice.count", async () => {
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 0, taxAmount: 0 } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 0 } });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.getTenantId.mockReturnValue("tenant-acme");
      // COUNT(*) comes back from Postgres as a bigint
      prisma.$queryRaw.mockResolvedValue([{ count: BigInt(2) }]);

      const result = await service.getSummary();

      expect(result.overdueCount).toBe(2);
      expect(prisma.invoice.count).not.toHaveBeenCalled(); // the status + due-date-only count was the bug
      const { sql, values } = prisma.$queryRaw.mock.calls[0][0] as {
        sql: string;
        values: unknown[];
      };
      expect(values).toEqual(
        expect.arrayContaining(["tenant-acme", "SENT", "VIEWED", "PARTIAL", "OVERDUE", "PAID"]),
      );
      expect(sql).not.toContain("tenant-acme");
      expect(sql).toMatch(/"i"\."total"\s*-\s*COALESCE\(/); // the balance predicate is in the query
    });
  });

  // ─── SA-770: an overpaid open invoice never makes an overdue figure negative ──
  describe("getCustomerBalanceSummary — per-customer overdue is clamped (SA-770)", () => {
    const PAST = new Date("2020-01-01T00:00:00.000Z");
    const FUTURE = new Date("2099-01-01T00:00:00.000Z");
    const customer = { id: "c1", businessName: "Acme", contactName: null, phone: null };
    const inv = (id: string, total: number, paid: number, dueDate: Date, status = "SENT") => ({
      id,
      customerId: "c1",
      customer,
      status,
      total,
      dueDate,
      payments: paid ? [{ amount: paid, status: "PAID" }] : [],
    });
    const run = async (rows: any[]) => {
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      prisma.invoice.findMany.mockResolvedValue(rows);
      const res: any = await service.getCustomerBalanceSummary();
      return res.data[0];
    };

    it("an overpaid open past-due invoice contributes 0, not a negative", async () => {
      const row = await run([inv("over", 100, 110, PAST)]);
      expect(row.overdue).toBe(0);
    });

    it("a mix: only the genuinely overdue invoice counts (before the fix: 50 - 10 = 40)", async () => {
      const row = await run([inv("over", 100, 110, PAST), inv("owes", 50, 0, PAST, "OVERDUE")]);
      expect(row.overdue).toBe(50);
    });

    it("overdue is the sum of the POSITIVE balances of open past-due invoices, in cents", async () => {
      const row = await run([
        inv("a", 0.1, 0, PAST),
        inv("b", 0.2, 0, PAST),
        inv("partial", 100, 40, PAST, "PARTIAL"),
        inv("exact", 80, 80, PAST),
        inv("over", 30, 90, PAST),
        inv("not-due", 500, 0, FUTURE),
      ]);
      expect(row.overdue).toBe(60.3);
    });
  });

  // ─── SA-770 row 310: every receivable / aging / AR figure is the clamped invoice balance ──
  // An OVERPAID open invoice (P-3 keeps it out of PAID) must never net against what other customers
  // owe: each invoice contributes max(0, roundMoney(total - confirmed payments)). Float dust (11 x $0.10
  // against $1.10) must not become a phantom receivable either.
  describe("SA-770 row 310 — receivables, aging and per-customer figures use the clamped balance", () => {
    const PAST = new Date("2020-01-01T00:00:00.000Z");
    const FUTURE = new Date("2099-01-01T00:00:00.000Z");
    const cust = { id: "c1", businessName: "Acme", contactName: null, phone: null };
    const pay = (amount: number) => ({ amount, status: "PAID", method: "CASH" });
    const row = (id: string, total: number, payments: any[], dueDate: Date, status = "SENT") => ({
      id,
      invoiceNumber: id.toUpperCase(),
      customerId: "c1",
      customer: cust,
      status,
      total,
      dueDate,
      issueDate: PAST,
      payments,
    });
    const overpaid = () => row("over", 100, [pay(130)], PAST);
    const owing = () => row("owes", 50, [], PAST, "OVERDUE");
    // 11 x $0.10 sums to 1.0999999999999999 in floats: a phantom $2e-16 balance against $1.10
    const dusty = () =>
      row(
        "dust",
        1.1,
        Array.from({ length: 11 }, () => pay(0.1)),
        FUTURE,
      );

    beforeEach(() => {
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 0, taxAmount: 0 } });
      prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.return.aggregate.mockResolvedValue({ _sum: { refundAmount: 0 } });
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.$queryRaw.mockResolvedValue([{ count: 0 }]);
    });

    it("getSummary: receivables = ONLY the owing balance (overpaid + owing: 50, not 50 - 30 = 20)", async () => {
      prisma.invoice.findMany.mockResolvedValue([overpaid(), owing()]);
      const res = await service.getSummary();
      expect(res.outstandingReceivables).toBe(50);
    });

    it("getSummary: float dust is not a receivable", async () => {
      prisma.invoice.findMany.mockResolvedValue([dusty()]);
      expect((await service.getSummary()).outstandingReceivables).toBe(0);
    });

    it("guard: getMobileDashboard totalOutstanding sums only owing balances (overpaid + owing across customers)", async () => {
      const other = { ...owing(), id: "owes2", customerId: "c2", total: 25 };
      prisma.invoice.findMany.mockResolvedValue([overpaid(), owing(), other]);
      expect((await service.getMobileDashboard()).totalOutstanding).toBe(75);
    });

    it("getMobileDashboard: float dust is exactly 0, not 2e-16", async () => {
      prisma.invoice.findMany.mockResolvedValue([dusty()]);
      expect((await service.getMobileDashboard()).totalOutstanding).toBe(0);
    });

    // The receivables reads select their payments explicitly: dropping `status` would make
    // confirmedBalance see no CONFIRMED rows and silently show GROSS receivables while the mocks stay green.
    // (only the OPEN-status receivables reads; the accrual-sales read has its own amount-only select)
    const paymentsSelect = (calls: any[][]) =>
      calls
        .filter((c) => c[0]?.where?.status?.in?.includes("SENT") && c[0]?.select?.payments)
        .map((c) => c[0].select.payments);
    it("getSummary and getMobileDashboard select the payments' amount AND status (confirmed rows only)", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      await service.getSummary();
      await service.getMobileDashboard();
      const sels = paymentsSelect(prisma.invoice.findMany.mock.calls);
      expect(sels).toHaveLength(2);
      for (const sel of sels)
        expect(sel).toEqual({
          where: { status: "PAID" },
          select: { amount: true, status: true },
        });
    });

    it("getFinanceDashboard: AR aging never goes negative and its buckets sum to the total", async () => {
      prisma.invoice.findMany.mockResolvedValue([overpaid(), owing(), dusty()]);
      const { arAging } = await service.getFinanceDashboard();
      expect(arAging.total).toBe(50); // the dust invoice adds exactly 0
      expect(
        arAging.days45plus +
          arAging.current +
          arAging.days1_15 +
          arAging.days16_30 +
          arAging.days31_45,
      ).toBe(arAging.total);
      for (const b of [
        arAging.current,
        arAging.days1_15,
        arAging.days16_30,
        arAging.days31_45,
        arAging.days45plus,
      ])
        expect(b).toBeGreaterThanOrEqual(0);
      expect(arAging.current).toBe(0); // float dust did not land in "current"
    });

    it("guard: getFinanceDashboard's summary-table 'due' is the clamped balance", async () => {
      prisma.invoice.findMany.mockResolvedValue([overpaid(), owing()]);
      const { summaryTable } = await service.getFinanceDashboard();
      expect(summaryTable.today.due).toBe(50);
    });

    it("getFinanceDashboard: the summary-table 'due' of float dust is exactly 0", async () => {
      prisma.invoice.findMany.mockResolvedValue([dusty()]);
      const { summaryTable } = await service.getFinanceDashboard();
      expect(summaryTable.today.due).toBe(0);
    });

    // Non-trivial bucket arithmetic: cents spread across ALL FIVE buckets, each bucket's sum needing a
    // round, and the total equal to the rounded sum of the buckets.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);
    const spread = () => [
      row("b0", 0.1, [], FUTURE),
      row("b1", 0.2, [], daysAgo(5), "OVERDUE"),
      row("b1x", 0.1, [], daysAgo(6), "OVERDUE"),
      row("b2", 0.3, [], daysAgo(20), "OVERDUE"),
      row("b3", 0.4, [], daysAgo(40), "OVERDUE"),
      row("b4", 0.7, [], daysAgo(90), "OVERDUE"),
      row("b4x", 0.2, [], daysAgo(91), "OVERDUE"),
      overpaid(),
    ];
    it("getFinanceDashboard: cents across different buckets round, and the buckets sum to the total", async () => {
      prisma.invoice.findMany.mockResolvedValue(spread());
      const { arAging } = await service.getFinanceDashboard();
      expect([
        arAging.current,
        arAging.days1_15,
        arAging.days16_30,
        arAging.days31_45,
        arAging.days45plus,
      ]).toEqual([0.1, 0.3, 0.3, 0.4, 0.9]); // 0.2+0.1 and 0.7+0.2 would be float dust unrounded
      expect(arAging.total).toBe(2.0);
    });

    it("getArAgingInvoices: per-bucket totals and the grand total are rounded to cents (they agree with the dashboard)", async () => {
      prisma.invoice.findMany.mockResolvedValue(spread());
      const res: any = await service.getArAgingInvoices();
      const vals = Object.entries(res.totals).filter(([k]) => k !== "total");
      // current | 1-30 (0.2 + 0.1 + 0.3 = 0.6000000000000001 unrounded) | 31-60 | 61-90 | 90+
      expect(vals.map(([, v]) => v)).toEqual([0.1, 0.6, 0.4, 0.7, 0.2]);
      expect(res.totals.total).toBe(2.0);
    });

    it("getArAgingInvoices: the overpaid and the dust invoices are absent; totals = the owing balance", async () => {
      prisma.invoice.findMany.mockResolvedValue([overpaid(), owing(), dusty()]);
      const res: any = await service.getArAgingInvoices();
      const ids = Object.values(res.buckets)
        .flat()
        .map((e: any) => e.id);
      expect(ids).toEqual(["owes"]);
      expect(res.totals.total).toBe(50);
    });

    it("getArAgingDetails: rows with no balance (overpaid, dust) are filtered out", async () => {
      prisma.invoice.findMany.mockResolvedValue([overpaid(), owing(), dusty()]);
      const res: any = await service.getArAgingDetails();
      expect(res.data.map((r: any) => r.id)).toEqual(["owes"]);
      expect(res.data[0].balance).toBe(50);
    });

    it("getCustomerBalanceSummary: the per-customer balance is the sum of CLAMPED balances; closingBalance stays SIGNED (a net position)", async () => {
      prisma.invoice.findMany.mockResolvedValue([overpaid(), owing()]);
      const [c] = ((await service.getCustomerBalanceSummary()) as any).data;
      expect(c.balance).toBe(50); // before: 50 + (100 - 130) = 20
      expect(c.overdue).toBe(50);
      // closingBalance = invoiced - received, deliberately signed: Dr/Cr indicator (a net, never clamped)
      expect(c.closingBalance).toBe(150 - 130);
      prisma.invoice.findMany.mockResolvedValue([overpaid()]);
      const [o] = ((await service.getCustomerBalanceSummary()) as any).data;
      expect({ closing: o.closingBalance, ind: o.indicator, balance: o.balance }).toEqual({
        closing: -30,
        ind: "Cr",
        balance: 0,
      });
    });

    it("getCustomerBalanceSummary: float dust in the net position reads as zero ('—'), not Dr; the sign is kept", async () => {
      // 1.1 invoiced, 11 x $0.10 received: 1.1 - 1.0999999999999999 = 2e-16 unrounded
      prisma.invoice.findMany.mockResolvedValue([dusty()]);
      const [c] = ((await service.getCustomerBalanceSummary()) as any).data;
      expect({ closing: c.closingBalance, ind: c.indicator }).toEqual({
        closing: 0,
        ind: "—",
      });
      // still signed: an overpayment is a credit
      prisma.invoice.findMany.mockResolvedValue([overpaid()]);
      const [o] = ((await service.getCustomerBalanceSummary()) as any).data;
      expect({ closing: o.closingBalance, ind: o.indicator }).toEqual({ closing: -30, ind: "Cr" });
    });

    // OWNER RULING 2026-10-11 (supersedes the row-310 pin that read 0 here): the Receivable Summary
    // report alone shows an overpayment as a NEGATIVE invoice-row balance. Every other surface stays
    // clamped (overdue-readers-inventory.spec.ts pins that `signedBalance` is used by this reader only).
    describe("getReceivableSummary — signed invoice-row balance (owner ruling 2026-10-11)", () => {
      const summaryRows = async (invoices: any[]) => {
        prisma.invoice.findMany.mockResolvedValue(invoices);
        prisma.creditNote.findMany.mockResolvedValue([]);
        prisma.invoicePayment.findMany.mockResolvedValue([]);
        const res: any = await service.getReceivableSummary();
        return res.data.filter((r: any) => r.type === "INVOICE");
      };

      it("an overpaid PAID invoice shows -10.00; the surplus is also visible on the PAYMENT row", async () => {
        const paidOver = row("po", 100, [pay(110)], PAST, "PAID");
        prisma.invoice.findMany.mockResolvedValue([paidOver, owing()]);
        prisma.creditNote.findMany.mockResolvedValue([]);
        prisma.invoicePayment.findMany.mockResolvedValue([
          {
            id: "p1",
            paymentNumber: "PAY-1",
            createdAt: PAST,
            status: "PAID",
            amount: 110,
            invoice: { invoiceNumber: "PO", customer: cust },
          },
        ]);
        const res: any = await service.getReceivableSummary();
        const inv = res.data.filter((r: any) => r.type === "INVOICE");
        expect(inv.map((r: any) => [r.transactionNumber, r.balance])).toEqual([
          ["PO", -10],
          ["OWES", 50],
        ]);
        expect(res.data.find((r: any) => r.type === "PAYMENT").total).toBe(110);
      });

      it("exactly paid reads 0 and a partial payment reads a positive balance", async () => {
        const rows = await summaryRows([
          row("exact", 100, [pay(100)], PAST, "PAID"),
          row("part", 100, [pay(40)], PAST, "PARTIAL"),
        ]);
        expect(rows.map((r: any) => [r.transactionNumber, r.balance])).toEqual([
          ["EXACT", 0],
          ["PART", 60],
        ]);
      });

      it("an overpaid + owing pair: each row keeps its own sign (no netting inside a row)", async () => {
        const rows = await summaryRows([overpaid(), owing()]);
        expect(rows.map((r: any) => [r.transactionNumber, r.balance])).toEqual([
          ["OVER", -30],
          ["OWES", 50],
        ]);
      });

      it("float dust (11 x $0.10 against $1.10) reads 0, never -2e-16 / 2e-16", async () => {
        const rows = await summaryRows([dusty()]);
        expect(Object.is(rows[0].balance, 0)).toBe(true);
      });

      it("only confirmed payments count: a VOID payment does not make the row negative", async () => {
        const rows = await summaryRows([
          row("v", 100, [{ amount: 100, status: "VOID", method: "CASH" }], PAST, "SENT"),
        ]);
        expect(rows[0].balance).toBe(100);
      });
    });

    it("getInvoiceDetailsReport: an overpaid row shows balance 0 (paid > total stays visible), not a negative", async () => {
      prisma.invoice.findMany.mockResolvedValue([overpaid()]);
      const res: any = await service.getInvoiceDetailsReport();
      expect(res.data[0]).toMatchObject({ total: 100, paid: 130, balance: 0 });
    });

    it("getBadDebtsReport: the footer total is the sum of clamped balances", async () => {
      const wo = (id: string, total: number, paid: number) => ({
        ...row(id, total, paid ? [pay(paid)] : [], PAST, "WRITTEN_OFF"),
        writtenOffAt: PAST,
        writeOffReason: null,
      });
      prisma.invoice.findMany.mockResolvedValue([wo("a", 100, 130), wo("b", 40, 0)]);
      const res: any = await service.getBadDebtsReport();
      expect(res.data.map((r: any) => r.balance)).toEqual([0, 40]);
      expect(res.total).toBe(40);
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
    const payment = (over: Record<string, any>): Record<string, any> => ({
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

    it("REG-B288: a supplier-credit draw and a VOID bill's payment are not cash out", async () => {
      const bp = (over: Record<string, any>) => ({
        paidAt: new Date("2026-02-10T00:00:00Z"),
        method: "CASH",
        vendorBill: { status: "PAID" },
        ...over,
      });
      const ROWS = [
        bp({ id: "bp-cash", amount: 200 }),
        bp({ id: "bp-credit-draw", amount: 1000, method: "CREDIT_NOTE" }),
        bp({ id: "bp-void-bill", amount: 75, vendorBill: { status: "VOID" } }),
      ];
      // The mock does not evaluate `where`; apply the two filters the service must send.
      prisma.billPayment.findMany.mockImplementation(async (args: any) =>
        ROWS.filter(
          (r) =>
            (args.where.method?.not === undefined || r.method !== args.where.method.not) &&
            (args.where.vendorBill?.status?.not === undefined ||
              r.vendorBill.status !== args.where.vendorBill.status.not),
        ),
      );

      const result = await service.getCashFlow(FROM, TO);

      // Master: 1275 (the $1,000 credit draw and the voided bill's $75 counted as cash out).
      expect(result.totalOut).toBe(200);
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
          $executeRaw: jest.fn(), // SA-404f F1: lockInvoicesForPayment
          invoice: {
            findMany: jest.fn(async () => []),
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
          return Promise.resolve([
            {
              total: 500,
              payments: [
                { amount: 150, status: "PAID" },
                { amount: 50, status: "PAID" },
              ],
            },
          ]);
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
        { productId: "p1", effectiveAt: new Date("2026-06-01"), avgCostAfter: D(2) },
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
        payments: [
          { amount: 150, status: "PAID" },
          { amount: 50, status: "PAID" },
        ], // cash 150 + credit-note-applied 50 -> balance 300
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
        { productId: "p1", effectiveAt: new Date("2026-05-01"), avgCostAfter: D(2) },
        { productId: "p1", effectiveAt: new Date("2026-06-01"), avgCostAfter: D(3) },
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
        { productId: "p1", effectiveAt: new Date("2026-06-01"), avgCostAfter: D(0.335) },
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
        payments: [
          { amount: 150, status: "PAID" },
          { amount: 50, status: "PAID" },
        ], // cash 150 + credit-note-applied 50 -> balance 300
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

  describe("createExpense — nested line items carry the tenant (T6)", () => {
    // Nested creates bypass the forTenant() extension, so an itemized expense's ExpenseLineItem rows
    // must be stamped IN the nested literal. Unstamped they were written with a NULL tenantId (and
    // would be refused outright once the tenantId NOT NULL guard lands).
    it("stamps every nested ExpenseLineItem with the ambient tenant id", async () => {
      prisma.expense.create.mockResolvedValue({ id: "exp-new" });
      await service.createExpense(
        {
          date: new Date("2026-09-01T00:00:00Z"),
          amount: 0,
          isItemized: true,
          lineItems: [
            { account: "Supplies", amount: 5 },
            { account: "Fuel", amount: 7, notes: "n" },
          ],
        },
        "u1",
      );
      const created = prisma.expense.create.mock.calls[0][0].data.lineItems.create;
      expect(created).toHaveLength(2);
      for (const li of created) expect(li.tenantId).toBe("test-tenant");
    });
  });

  describe("createExpense — B781: the computed amount is rounded to the cent", () => {
    it("a mileage expense's distance x rate is cent-exact, not a float artifact", async () => {
      // 3 x 0.335 === 1.0050000000000001 in plain JS float multiplication — a
      // real-world sub-cent mileage rate (33.5c/mile).
      prisma.mileageRate.findFirst.mockResolvedValue({ ratePerUnit: 0.335 });
      prisma.expense.create.mockResolvedValue({ id: "exp-mileage" });

      await service.createExpense(
        {
          date: new Date("2026-09-01T00:00:00Z"),
          isMileage: true,
          distance: 3,
          mileageUnit: "MILE",
        },
        "u1",
      );

      const data = prisma.expense.create.mock.calls[0][0].data;
      expect(data.amount).toBe(1.01);
      expect(data.amount).not.toBe(1.0050000000000001);
    });

    it("an itemized expense's line-item sum is cent-exact, not a float artifact", async () => {
      prisma.expense.create.mockResolvedValue({ id: "exp-itemized" });

      await service.createExpense(
        {
          date: new Date("2026-09-01T00:00:00Z"),
          isItemized: true,
          lineItems: [
            { account: "Supplies", amount: 0.1 },
            { account: "Fuel", amount: 0.2 },
          ],
        },
        "u1",
      );

      const data = prisma.expense.create.mock.calls[0][0].data;
      expect(data.amount).toBe(0.3);
      expect(data.amount).not.toBe(0.30000000000000004);
    });

    it("a mileage expense with a CLIENT-supplied rate snapshot is still rounded (the auto-lookup branch never runs for it)", async () => {
      // The web mileage form always sends mileageRateSnapshot, so `!rateSnapshot`
      // is false and the auto-lookup branch above is skipped entirely — the
      // unrounded distance*rate arrives here as a plain `amount` passthrough.
      prisma.expense.create.mockResolvedValue({ id: "exp-mileage-snapshot" });

      await service.createExpense(
        {
          date: new Date("2026-09-01T00:00:00Z"),
          isMileage: true,
          distance: 3,
          mileageUnit: "MILE",
          mileageRateSnapshot: 0.335,
          amount: 3 * 0.335,
        },
        "u1",
      );

      const data = prisma.expense.create.mock.calls[0][0].data;
      expect(data.amount).toBe(1.01);
      expect(data.amount).not.toBe(1.0050000000000001);
    });

    it("a plain (non-mileage, non-itemized) expense's amount is still rounded", async () => {
      prisma.expense.create.mockResolvedValue({ id: "exp-plain" });

      await service.createExpense(
        { date: new Date("2026-09-01T00:00:00Z"), amount: 0.1 + 0.2 },
        "u1",
      );

      const data = prisma.expense.create.mock.calls[0][0].data;
      expect(data.amount).toBe(0.3);
      expect(data.amount).not.toBe(0.30000000000000004);
    });

    it("each itemized line is rounded on write, so the stored lines always sum to the header total", async () => {
      // 0.005 + 0.005: each line rounds independently to 0.01, header is their
      // sum (0.02) — never a raw-float sum that could drift from the lines.
      prisma.expense.create.mockResolvedValue({ id: "exp-itemized-lines" });

      await service.createExpense(
        {
          date: new Date("2026-09-01T00:00:00Z"),
          isItemized: true,
          lineItems: [
            { account: "Supplies", amount: 0.005 },
            { account: "Fuel", amount: 0.005 },
          ],
        },
        "u1",
      );

      const data = prisma.expense.create.mock.calls[0][0].data;
      const created = data.lineItems.create;
      expect(created.map((li: any) => li.amount)).toEqual([0.01, 0.01]);
      expect(data.amount).toBe(0.02);
    });
  });

  describe("updateExpense — SA-121: dto.amount is rounded to the cent", () => {
    it("a float-artifact amount (0.1 + 0.2) is stored cent-exact, not 0.30000000000000004", async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: "exp-1",
        status: "PENDING",
        receivedAt: null,
        paidAt: null,
      });
      prisma.expense.update.mockResolvedValue({ id: "exp-1" });

      await service.updateExpense("exp-1", { amount: 0.1 + 0.2 });

      const data = prisma.expense.update.mock.calls[0][0].data;
      expect(data.amount).toBe(0.3);
      expect(data.amount).not.toBe(0.30000000000000004);
    });

    it("row 591 sibling: a null amount keeps the stored amount (never an expense of $0)", async () => {
      prisma.expense.findFirst.mockResolvedValue({
        id: "exp-1",
        status: "PENDING",
        receivedAt: null,
        paidAt: null,
      });
      prisma.expense.update.mockResolvedValue({ id: "exp-1" });

      await service.updateExpense("exp-1", { amount: null, notes: "n" });

      const data = prisma.expense.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("amount"); // a direct read wrote roundMoney(null) = 0
      expect(data.notes).toBe("n");
    });
  });

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

    it("REG-B801: a single OCR line item's amount is cent-exact, not a float artifact", async () => {
      const lineItemModel = graftExpenseLineItem();
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            // 3 x 0.335 === 1.0050000000000001 in plain JS float multiplication.
            text: JSON.stringify({
              vendor: "Acme",
              items: [{ description: "Delivery", qty: 3, unitCost: 0.335, amount: 3 * 0.335 }],
            }),
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      await service.extractExpenseItems("exp-1");

      const created = lineItemModel.createMany.mock.calls[0][0].data;
      expect(created[0].amount).toBe(1.01);
      expect(created[0].amount).not.toBe(1.0050000000000001);

      const updateData = prisma.expense.update.mock.calls[0][0].data;
      expect(updateData.amount).toBe(1.01);
    });

    it("REG-B801: each OCR line item is rounded on write, so the stored lines sum exactly to the header total", async () => {
      const lineItemModel = graftExpenseLineItem();
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              vendor: "Acme",
              items: [
                { description: "A", amount: 0.005 },
                { description: "B", amount: 0.005 },
              ],
            }),
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      await service.extractExpenseItems("exp-1");

      const created = lineItemModel.createMany.mock.calls[0][0].data;
      expect(created.map((li: any) => li.amount)).toEqual([0.01, 0.01]);

      const updateData = prisma.expense.update.mock.calls[0][0].data;
      expect(updateData.amount).toBe(0.02);
    });
  });
});
