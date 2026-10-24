jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));

import { Test } from "@nestjs/testing";
import { InvoiceStatus, NotificationEvent } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * SA-655 (e): `send(id, { suppressNotify: true })` flips the invoice SENT exactly as before but
 * skips the INVOICE_SENT message (the counter sale's walk-in customer has no mailbox). Every other
 * caller passes no such option and still notifies once, on the DRAFT -> SENT flip.
 */
describe("InvoicesService.send — suppressNotify", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let notifyEvent: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    notifyEvent = jest.fn().mockResolvedValue(undefined);
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("false") } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        {
          provide: CreditNotesService,
          useValue: {
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: InvoiceStatus.SENT }),
          },
        },
        { provide: MessagingService, useValue: { notifyEvent } },
        { provide: StorageService, useValue: {} },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: () => ({ can: () => Promise.resolve(false) }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(InvoicesService);
    prisma.invoice.findUnique.mockResolvedValue({
      id: "i1",
      orderId: null,
      status: InvoiceStatus.DRAFT,
      deliveryBatchId: null,
    });
    prisma.invoice.update.mockResolvedValue({
      id: "i1",
      invoiceNumber: "INV-1",
      customerId: "c1",
      status: InvoiceStatus.SENT,
      total: 10,
      dueDate: null,
    });
  });

  it("default: notifies INVOICE_SENT once on the DRAFT -> SENT flip (unchanged)", async () => {
    await service.send("i1");
    expect(notifyEvent).toHaveBeenCalledTimes(1);
    expect(notifyEvent.mock.calls[0][0]).toBe(NotificationEvent.INVOICE_SENT);
  });

  it("suppressNotify: still flips to SENT, but sends no INVOICE_SENT message", async () => {
    await service.send("i1", { suppressNotify: true });
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: InvoiceStatus.SENT }) }),
    );
    expect(notifyEvent).not.toHaveBeenCalled();
  });
});
