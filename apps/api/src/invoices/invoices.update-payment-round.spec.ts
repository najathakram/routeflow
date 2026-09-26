/**
 * #2293 — `updatePayment` rounds the payment amount ONCE (money discipline: round every monetary
 * write) and uses that one value for the remaining-capacity guard, the invoice-status math and the
 * row write; `bankCharges` is rounded too.
 *
 * WHY IT WAS REACHABLE: `UpdatePaymentDto.amount` is `@IsNumber() @Min(0.01)` with no
 * `maxDecimalPlaces` (the sibling `AllocationDto` caps at 2), so a sub-cent amount reached the
 * service. The column is `Decimal(10,2)`, so Postgres rounds what it STORES — while the status math
 * and the guard used the raw value and disagreed with the stored row: a 10.005 payment on a 10.01
 * invoice was stored as 10.01 but left the invoice PARTIAL, and 10.004 on a 10.00 invoice was
 * rejected as over the balance. Own file: invoices.service.spec.ts is at its size ratchet.
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

describe("InvoicesService.updatePayment — rounds the amount once (#2293)", () => {
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
        { provide: CreditNotesService, useValue: {} },
        { provide: MessagingService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
      ],
    }).compile();
    service = module.get<InvoicesService>(InvoicesService);
  });

  /** An invoice whose ONLY payment is the one being edited. */
  const seedSole = (total: number) => {
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total,
      dueDate: null,
      payments: [{ id: "pay-1", status: "PAID", amount: 1, settledAt: null }],
    });
    prisma.invoice.update.mockResolvedValue({
      id: "inv-1",
      invoiceNumber: "INV-0001",
      customerId: "cust-1",
      total,
      payments: [],
    });
  };
  const written = () => (prisma.invoicePayment.update.mock.calls[0][0] as any).data;
  const invoiceData = () => (prisma.invoice.update.mock.calls[0][0] as any).data;

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

  it("a genuinely over-balance amount is still refused after rounding", async () => {
    seedSole(10);
    await expect(
      service.updatePayment("inv-1", "pay-1", { amount: 10.006, method: "CHECK" } as any),
    ).rejects.toThrow("Payment amount exceeds remaining balance");
    expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
  });

  it("leaves bankCharges untouched when the key is absent", async () => {
    seedSole(100);
    await service.updatePayment("inv-1", "pay-1", { amount: 5, method: "CHECK" } as any);
    expect(written()).not.toHaveProperty("bankCharges");
  });
});
