import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { StatementService } from "./statement.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const MOCK_CUSTOMER = { id: "cust-1", businessName: "Acme Corp" };

describe("StatementService (P5-15 — monthly statement reconciliation)", () => {
  let service: StatementService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [StatementService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<StatementService>(StatementService);
  });

  describe("buildMonthlyStatement — reconciliation identity", () => {
    // INV_100: total 500, issued May 2026. Payments: 200 (May, CASH, non-VOID —
    // makes opening 300), 100 (June, CHECK, non-VOID — a payments-bucket row),
    // 50 (June, VOID — must NEVER count anywhere), 80 (June, CREDIT_NOTE — a
    // credits-bucket row, not payments).
    const INV_100 = {
      id: "inv-100",
      invoiceNumber: "INV-100",
      total: 500,
      status: "SENT",
      issueDate: new Date("2026-05-01T00:00:00.000Z"),
      payments: [
        {
          amount: 200,
          paidAt: new Date("2026-05-10T00:00:00.000Z"),
          status: "PAID",
          method: "CASH",
        },
        {
          amount: 100,
          paidAt: new Date("2026-06-05T00:00:00.000Z"),
          status: "PAID",
          method: "CHECK",
        },
        {
          amount: 50,
          paidAt: new Date("2026-06-06T00:00:00.000Z"),
          status: "VOID",
          method: "CHECK",
        },
        {
          amount: 80,
          paidAt: new Date("2026-06-07T00:00:00.000Z"),
          status: "PAID",
          method: "CREDIT_NOTE",
        },
      ],
    };

    // INV_101: 250, issued Jun 15, unpaid — a plain in-month charge.
    const INV_101 = {
      id: "inv-101",
      invoiceNumber: "INV-101",
      total: 250,
      status: "SENT",
      issueDate: new Date("2026-06-15T00:00:00.000Z"),
      payments: [],
    };

    // What the DB's month-payments query returns: only the non-VOID rows PAID
    // in June (the 200 CASH is out of range — paid in May; the 50 VOID is
    // excluded by the query's own `status: { not: "VOID" }` filter).
    const MONTH_PAYMENT_ROWS = [
      {
        id: "pay-check",
        amount: 100,
        method: "CHECK",
        reference: null,
        paidAt: new Date("2026-06-05T00:00:00.000Z"),
        invoice: { invoiceNumber: "INV-100" },
      },
      {
        id: "pay-credit-note",
        amount: 80,
        method: "CREDIT_NOTE",
        reference: null,
        paidAt: new Date("2026-06-07T00:00:00.000Z"),
        invoice: { invoiceNumber: "INV-100" },
      },
    ];

    beforeEach(() => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([INV_100, INV_101]);
      prisma.invoicePayment.findMany.mockResolvedValue(MONTH_PAYMENT_ROWS);
      prisma.creditNote.findMany.mockResolvedValue([]);
    });

    it("reconciles a normal month: opening 300, charges 250, payments 100, credits 80, closing 370", async () => {
      const stmt = await service.buildMonthlyStatement("cust-1", "2026-06");

      expect(stmt.opening).toBe(300);
      expect(stmt.charges).toBe(250);
      expect(stmt.payments).toBe(100);
      expect(stmt.credits).toBe(80);
      expect(stmt.adjustments).toBe(0);
      expect(stmt.closing).toBe(370);
      expect(stmt.opening + stmt.charges - stmt.payments - stmt.credits + stmt.adjustments).toBe(
        stmt.closing,
      );
    });

    it("excludes VOID payments from every figure (closing 370, not 320)", async () => {
      const stmt = await service.buildMonthlyStatement("cust-1", "2026-06");

      // If the 50 VOID payment were wrongly counted as paid, closing would be
      // 320 (500 - 430 - ... ) instead of the correct 370.
      expect(stmt.closing).toBe(370);
      expect(stmt.closing).not.toBe(320);
      expect(stmt.lineItems.some((li) => li.amount === -50)).toBe(false);
    });

    it("routes a CREDIT_NOTE-method application into credits, not payments (no double-count)", async () => {
      const stmt = await service.buildMonthlyStatement("cust-1", "2026-06");

      expect(stmt.credits).toBe(80);
      expect(stmt.payments).toBe(100);

      const creditLine = stmt.lineItems.find((li) => li.type === "CREDIT");
      expect(creditLine).toBeDefined();
      expect(creditLine?.amount).toBe(-80);
      expect(stmt.lineItems.some((li) => li.type === "PAYMENT" && li.amount === -80)).toBe(false);
    });

    it("absorbs a mid-month write-off into adjustments so the identity still holds exactly", async () => {
      const INV_200_WRITTEN_OFF = {
        id: "inv-200",
        invoiceNumber: "INV-200",
        total: 90,
        status: "WRITTEN_OFF",
        issueDate: new Date("2026-06-02T00:00:00.000Z"),
        payments: [],
      };
      prisma.invoice.findMany.mockResolvedValue([INV_100, INV_101, INV_200_WRITTEN_OFF]);

      const stmt = await service.buildMonthlyStatement("cust-1", "2026-06");

      expect(stmt.charges).toBe(340); // 250 + 90 — charges excludes only DRAFT/VOID
      expect(stmt.closing).toBe(370); // unchanged — WRITTEN_OFF invoices excluded from receivableAt
      expect(stmt.adjustments).toBe(-90);
      expect(stmt.opening + stmt.charges - stmt.payments - stmt.credits + stmt.adjustments).toBe(
        stmt.closing,
      );
    });

    it("queries invoices excluding DRAFT/VOID and payments narrowed to CONFIRMED (REG-B11)", async () => {
      await service.buildMonthlyStatement("cust-1", "2026-06");

      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            customerId: "cust-1",
            status: { notIn: ["DRAFT", "VOID"] },
          }),
        }),
      );
      expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "PAID",
          }),
        }),
      );
    });

    it("REG-B11: a DRAFT payment never reduces the receivable the customer is shown", async () => {
      // The customer-facing statement must agree with the invoice PDF and the
      // reminder email, which now report on the CONFIRMED basis: an unconfirmed
      // $120 DRAFT row is not collected money, so closing stays 370, not 250.
      prisma.invoice.findMany.mockResolvedValue([
        {
          ...INV_100,
          payments: [
            ...INV_100.payments,
            {
              amount: 120,
              paidAt: new Date("2026-06-08T00:00:00.000Z"),
              status: "DRAFT",
              method: "BANK_TRANSFER",
            },
          ],
        },
        INV_101,
      ]);

      const stmt = await service.buildMonthlyStatement("cust-1", "2026-06");

      expect(stmt.closing).toBe(370);
      expect(stmt.closing).not.toBe(250);
      expect(stmt.opening).toBe(300);
      expect(stmt.opening + stmt.charges - stmt.payments - stmt.credits + stmt.adjustments).toBe(
        stmt.closing,
      );
    });

    it("availableCredit sums only non-VOID remainders (100/40 + VOID 15 -> 60)", async () => {
      prisma.creditNote.findMany.mockResolvedValue([
        { amount: 100, amountUsed: 40, status: "ISSUED", expiresAt: null },
        { amount: 15, amountUsed: 0, status: "VOID", expiresAt: null },
      ]);

      const stmt = await service.buildMonthlyStatement("cust-1", "2026-06");

      expect(stmt.availableCredit).toBe(60);
    });

    it("returns a zero-activity statement for a future month with no invoices/payments", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.creditNote.findMany.mockResolvedValue([]);

      const stmt = await service.buildMonthlyStatement("cust-1", "2099-01");

      expect(stmt.opening).toBe(0);
      expect(stmt.charges).toBe(0);
      expect(stmt.payments).toBe(0);
      expect(stmt.credits).toBe(0);
      expect(stmt.adjustments).toBe(0);
      expect(stmt.closing).toBe(0);
      expect(stmt.lineItems).toEqual([]);
    });
  });

  describe("buildMonthlyStatement — month validation", () => {
    it.each(["2026-13", "2026-1", "garbage", "202606"])(
      "rejects malformed month %s with a 400",
      async (month) => {
        await expect(service.buildMonthlyStatement("cust-1", month)).rejects.toThrow(
          BadRequestException,
        );
      },
    );
  });

  describe("buildMonthlyStatement — customer not found", () => {
    it("throws NotFoundException when the customer does not exist", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.creditNote.findMany.mockResolvedValue([]);

      await expect(service.buildMonthlyStatement("missing-cust", "2026-06")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("listAvailableMonths", () => {
    it("returns an empty list when the customer has no non-DRAFT/VOID invoices", async () => {
      prisma.invoice.findFirst.mockResolvedValue(null);

      const result = await service.listAvailableMonths("cust-1");

      expect(result).toEqual({ months: [] });
    });

    it("walks back to the earliest invoice's bucket, newest first", async () => {
      prisma.invoice.findFirst.mockResolvedValue({
        issueDate: new Date("2026-04-15T00:00:00.000Z"),
      });
      const now = new Date("2026-07-13T00:00:00.000Z");

      const result = await service.listAvailableMonths("cust-1", now);

      expect(result.months).toEqual(["2026-07", "2026-06", "2026-05", "2026-04"]);
    });

    it("caps at 12 buckets even when the earliest invoice predates the window", async () => {
      prisma.invoice.findFirst.mockResolvedValue({
        issueDate: new Date("2020-01-01T00:00:00.000Z"),
      });
      const now = new Date("2026-07-13T00:00:00.000Z");

      const result = await service.listAvailableMonths("cust-1", now);

      expect(result.months).toHaveLength(12);
      expect(result.months[0]).toBe("2026-07");
      expect(result.months[11]).toBe("2025-08");
    });
  });
});
