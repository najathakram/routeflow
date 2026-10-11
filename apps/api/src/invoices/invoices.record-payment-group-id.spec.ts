/**
 * Split-payment tender: the counter tags each leg's payment rows with a server-built `paymentGroupId`
 * (uuidv5 of orderId:legIndex). recordPayment takes it as an internal third argument and writes it IN THE
 * SAME InvoicePayment create, never stamped afterwards (a crash between create and stamp would leave an
 * ungrouped row the replay rules read as a different tender). Without it the write is exactly today's
 * (the office multi-invoice path keeps its own random group id, untouched).
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

describe("InvoicesService.recordPayment: the optional paymentGroupId (split counter tender)", () => {
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

  const seed = () => {
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total: 100,
      dueDate: null,
      payments: [],
    });
    prisma.invoice.update.mockResolvedValue({
      id: "inv-1",
      invoiceNumber: "INV-0001",
      customerId: "cust-1",
      total: 100,
      payments: [],
    });
  };
  const created = () => (prisma.invoicePayment.create.mock.calls[0][0] as any).data;
  const GROUP = "7d3f0b5e-1a52-5c0e-8f4a-2b6d9e1c3a40";

  it("writes the given paymentGroupId in the SAME create, and never updates the row afterwards", async () => {
    seed();
    await service.recordPayment("inv-1", { amount: 30, method: "CREDIT_CARD" } as any, {
      paymentGroupId: GROUP,
    });
    expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    expect(created().paymentGroupId).toBe(GROUP);
    expect(created().amount).toBe(30);
    expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.updateMany).not.toHaveBeenCalled();
  });

  it("without options the create carries no paymentGroupId (today's write, byte for byte)", async () => {
    seed();
    await service.recordPayment("inv-1", { amount: 30, method: "CASH" } as any);
    expect(created().paymentGroupId).toBeUndefined();
  });
});
