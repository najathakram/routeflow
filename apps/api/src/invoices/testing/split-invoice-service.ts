/**
 * SA-681/SA-687 test harness: a REAL InvoicesService over a mock prisma (normally one that
 * SplitInvoiceFakeDb.install() has made stateful). The service CLASS is a parameter because the
 * orders-service harness jest.mock()s `invoices.service`; that spec passes
 * `jest.requireActual("../invoices/invoices.service").InvoicesService`. The caller must register the
 * `invoice-pdf.service` / `storage/compress.util` mocks (ESM-only traversal guards) itself.
 */
import { Test } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { NumberingService } from "../../import/numbering.service";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { EmailService } from "../../email/email.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { StorageService } from "../../storage/storage.service";
import { RegulatedLedgerService } from "../../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../../authorizations/authorization-guard.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { MessagingService } from "../../messaging/messaging.service";
import { EntitlementsService } from "../../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../../selling-restrictions/selling-restrictions.service";
import { EntitlementAuthority } from "../../billing/entitlement-authority.service";
import { InvoicePdfService } from "../invoice-pdf.service";

export async function buildSplitInvoicesService<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the (possibly requireActual'd) class
  InvoicesServiceCls: new (...args: any[]) => T,
  prisma: unknown,
  ledger: { writeSaleEntries: jest.Mock; reverseInvoiceEntries: jest.Mock } = {
    writeSaleEntries: jest.fn(),
    reverseInvoiceEntries: jest.fn(),
  },
): Promise<T> {
  let invoiceSeq = 0;
  const module = await Test.createTestingModule({
    providers: [
      { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
      InvoicesServiceCls,
      {
        provide: SellingRestrictionsService,
        useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: PrismaService, useValue: prisma },
      { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
      { provide: EmailService, useValue: { sendInvoice: jest.fn() } },
      { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
      {
        provide: SystemConfigService,
        useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
      },
      { provide: RegulatedLedgerService, useValue: ledger },
      {
        provide: AuthorizationGuardService,
        useValue: {
          assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
          checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
        },
      },
      {
        provide: CreditNotesService,
        useValue: {
          autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }),
          settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
          releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
        },
      },
      {
        provide: MessagingService,
        useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
      },
      { provide: StorageService, useValue: { upload: jest.fn() } },
      { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
      entitlementAuthorityFromEntitlements,
      {
        provide: CommissionEngineService,
        useValue: {
          syncInvoiceCommissionSafe: jest.fn(),
          syncOrderInvoices: jest.fn(),
          removeInvoiceCommission: jest.fn(),
        },
      },
      {
        provide: NumberingService,
        useValue: { reserveNext: jest.fn().mockImplementation(async () => `INV-${++invoiceSeq}`) },
      },
    ],
  }).compile();
  const service = module.get(InvoicesServiceCls);
  jest
    .spyOn(service as never, "resolveTenantInvoiceDefaults")
    .mockResolvedValue({ notes: null, terms: null, timezone: null } as never);
  return service;
}
