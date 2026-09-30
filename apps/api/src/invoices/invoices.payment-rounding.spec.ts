/**
 * #2293 / #2296 — every payment write rounds (money discipline: round every monetary write).
 *
 * `updatePayment` and `recordPayment` round the amount ONCE and use that one value for the
 * remaining-capacity guard, the invoice-status math and the row write. `bankCharges` is rounded at
 * all three writers (update, record, standalone), and an explicit `null` still clears it (never
 * written as 0.00).
 *
 * WHY IT WAS REACHABLE: `RecordInvoicePaymentDto` / `UpdatePaymentDto` carry `@IsNumber()` with no
 * `maxDecimalPlaces` (the sibling `AllocationDto` caps at 2), so sub-cent values reached the
 * service. The columns are `Decimal(10,2)`: Postgres rounds what it STORES, while the guard and the
 * status math used the raw value and disagreed with the stored row. For `bankCharges` the stored
 * value is therefore identical either way — these pins are on the value handed to Prisma; the
 * null-clear case is the one a real database tells apart (NULL vs 0.00).
 *
 * Own file: invoices.service.spec.ts is at its size ratchet.
 */

// Prevent Jest from traversing ESM-only dependencies
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));

jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

describe("InvoicesService — every payment write rounds (#2293)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        {
          provide: CreditNotesService,
          useValue: { autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }) },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = module.get<InvoicesService>(InvoicesService);
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 2 });
    prisma.invoicePayment.create.mockResolvedValue({ id: "pay-new" });
  });

  const invoiceData = () => (prisma.invoice.update.mock.calls[0][0] as any).data;

  /** An invoice with the given payments (the edited one is `pay-1`). */
  const seedInvoice = (total: number, payments: any[]) => {
    const row = { id: "inv-1", status: InvoiceStatus.SENT, total, dueDate: null, payments };
    prisma.invoice.findUnique.mockResolvedValue(row);
    prisma.invoice.update.mockResolvedValue({
      id: "inv-1",
      invoiceNumber: "INV-0001",
      customerId: "cust-1",
      total,
      payments: [],
    });
  };

  describe("updatePayment", () => {
    const written = () => (prisma.invoicePayment.update.mock.calls[0][0] as any).data;
    const seedSole = (total: number) =>
      seedInvoice(total, [{ id: "pay-1", status: "PAID", amount: 1, settledAt: null }]);

    it("writes the rounded amount and bank charges", async () => {
      seedSole(100);
      await service.updatePayment("inv-1", "pay-1", {
        amount: 10.005,
        method: "CHECK",
        bankCharges: 0.3333,
      } as any);
      expect(written().amount).toBe(10.01);
      expect(written().bankCharges).toBe(0.33);
    });

    it("computes the invoice status from the rounded amount (10.005 fully pays a 10.01 invoice)", async () => {
      seedSole(10.01);
      await service.updatePayment("inv-1", "pay-1", { amount: 10.005, method: "CHECK" } as any);
      expect(invoiceData().status).toBe(InvoiceStatus.PAID);
    });

    it("checks remaining capacity against the rounded amount (10.004 fits a 10.00 invoice)", async () => {
      seedSole(10);
      await expect(
        service.updatePayment("inv-1", "pay-1", { amount: 10.004, method: "CHECK" } as any),
      ).resolves.toBeDefined();
      expect(written().amount).toBe(10);
      expect(invoiceData().status).toBe(InvoiceStatus.PAID);
    });

    it("with another PAID and a DRAFT payment present: capacity counts both, status counts only the PAID", async () => {
      // 30.00 invoice; others: PAID 10 + DRAFT 10 → capacity 10.00; confirmed others 10.
      seedInvoice(30, [
        { id: "pay-1", status: "PAID", amount: 1, settledAt: null },
        { id: "pay-2", status: "PAID", amount: 10, settledAt: null },
        { id: "pay-3", status: "DRAFT", amount: 10, settledAt: null },
      ]);
      await service.updatePayment("inv-1", "pay-1", { amount: 10.004, method: "CHECK" } as any);
      expect(written().amount).toBe(10);
      expect(invoiceData().status).toBe(InvoiceStatus.PARTIAL); // 10 + 10 of 30
    });

    it("a genuinely over-balance amount is still refused after rounding", async () => {
      seedSole(10);
      await expect(
        service.updatePayment("inv-1", "pay-1", { amount: 10.006, method: "CHECK" } as any),
      ).rejects.toThrow("Payment amount exceeds remaining balance");
      expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    });

    it("bankCharges: an explicit null still clears it; an absent key leaves it untouched", async () => {
      seedSole(100);
      await service.updatePayment("inv-1", "pay-1", {
        amount: 5,
        method: "CHECK",
        bankCharges: null,
      } as any);
      expect(written()).toHaveProperty("bankCharges", null);

      prisma.invoicePayment.update.mockClear();
      await service.updatePayment("inv-1", "pay-1", { amount: 5, method: "CHECK" } as any);
      expect(written()).not.toHaveProperty("bankCharges");
    });
  });

  describe("recordPayment", () => {
    const created = () => (prisma.invoicePayment.create.mock.calls[0][0] as any).data;

    it("writes the rounded amount and computes the status from it (10.005 fully pays 10.01)", async () => {
      seedInvoice(10.01, []);
      await service.recordPayment("inv-1", { amount: 10.005, method: "CASH" } as any);
      expect(created().amount).toBe(10.01);
      expect(invoiceData().status).toBe(InvoiceStatus.PAID);
    });

    it("checks remaining capacity against the rounded amount (10.004 fits a 10.00 invoice)", async () => {
      seedInvoice(10, []);
      await expect(
        service.recordPayment("inv-1", { amount: 10.004, method: "CASH" } as any),
      ).resolves.toBeDefined();
      expect(created().amount).toBe(10);
    });

    it("with a PAID and a DRAFT payment already present: capacity counts both, status only the PAID", async () => {
      seedInvoice(30, [
        { id: "pay-2", status: "PAID", amount: 10 },
        { id: "pay-3", status: "DRAFT", amount: 10 },
      ]);
      await service.recordPayment("inv-1", { amount: 10.004, method: "CASH" } as any);
      expect(created().amount).toBe(10);
      expect(invoiceData().status).toBe(InvoiceStatus.PARTIAL);
    });

    it("bankCharges: rounded; an explicit null stays null; absent stays absent", async () => {
      seedInvoice(100, []);
      await service.recordPayment("inv-1", {
        amount: 5,
        method: "CASH",
        bankCharges: 0.3333,
      } as any);
      expect(created().bankCharges).toBe(0.33);

      prisma.invoicePayment.create.mockClear();
      await service.recordPayment("inv-1", {
        amount: 5,
        method: "CASH",
        bankCharges: null,
      } as any);
      expect(created().bankCharges).toBeNull();

      prisma.invoicePayment.create.mockClear();
      await service.recordPayment("inv-1", { amount: 5, method: "CASH" } as any);
      expect(created().bankCharges).toBeUndefined();
    });
  });

  describe("recordStandalonePayment", () => {
    const seedStandalone = () => {
      prisma.invoice.findFirst.mockResolvedValue({
        id: "inv-1",
        status: InvoiceStatus.SENT,
        total: 1000,
        dueDate: null,
        payments: [],
      });
      prisma.invoicePayment.findMany.mockResolvedValue([]);
    };
    const createdAt = (i: number) => (prisma.invoicePayment.create.mock.calls[i][0] as any).data;

    it("bankCharges: rounded on every allocation row; an explicit null stays null", async () => {
      seedStandalone();
      await service.recordStandalonePayment({
        customerId: "cust-1",
        totalAmount: 20,
        method: "CASH",
        bankCharges: 0.3333,
        allocations: [
          { invoiceId: "inv-1", amount: 10 },
          { invoiceId: "inv-1", amount: 10 },
        ],
      } as any);
      expect(createdAt(0).bankCharges).toBe(0.33);
      expect(createdAt(1).bankCharges).toBe(0.33);

      prisma.invoicePayment.create.mockClear();
      await service.recordStandalonePayment({
        customerId: "cust-1",
        totalAmount: 10,
        method: "CASH",
        bankCharges: null,
        allocations: [{ invoiceId: "inv-1", amount: 10 }],
      } as any);
      expect(createdAt(0).bankCharges).toBeNull();
    });
  });
});
