/**
 * Security tests for the invoices module.
 *
 * updateInvoiceShipment read an invoice via `forTenant().invoice.findUnique`
 * with an exclusive select omitting tenantId, defeating the post-filter tenant
 * guard — a cross-tenant invoice id acted as a status oracle. The read is now
 * the tenant-scoped `findFirst`; this spec pins "a cross-tenant id 404s":
 * findUnique is mocked to return the foreign row (raw-DB behavior), findFirst
 * to return null (scoped behavior) — reverting to findUnique fails the test.
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
import { NotFoundException } from "@nestjs/common";
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

const FOREIGN_INVOICE = { id: "inv-foreign", status: "SENT", shippedAt: null };

describe("InvoicesService — cross-tenant id 404s on scoped reads", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
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
        { provide: CommissionEngineService, useValue: {} },
      ],
    }).compile();
    service = module.get<InvoicesService>(InvoicesService);
  });

  describe("updateInvoiceShipment", () => {
    it("404s a cross-tenant invoice id and never writes", async () => {
      prisma.invoice.findUnique.mockResolvedValue(FOREIGN_INVOICE);
      prisma.invoice.findFirst.mockResolvedValue(null);

      await expect(
        service.updateInvoiceShipment("inv-foreign", { shippingTrackingNumber: "1Z" } as any),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it("updates a same-tenant invoice (scoped read hit)", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1", status: "SENT", shippedAt: null });
      prisma.invoice.update.mockResolvedValue({ id: "inv-1" });

      await service.updateInvoiceShipment("inv-1", { shippingTrackingNumber: "1Z" } as any);
      expect(prisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "inv-1" } }),
      );
    });
  });
});
