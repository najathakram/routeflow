/**
 * REG-B405: an invoice update() that moved the discount or the shipping fee recomputed the total WITHOUT the regulated category
 * tax (the levy, categoryTaxAmount), so a levy line lost its levy on every discount or shipping edit. update() now runs the one
 * builder over the stored lines (sumInvoiceTotals via planHeaderOnlyTotals), which carries the levy. The wrong value is the total
 * without the levy (subtotal - discount + shipping + regular tax only).
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { sumInvoiceTotals } from "@routeflow/pricing";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("REG-B405: a discount or shipping edit keeps the category tax in the total", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // units_v1 guard reads the parent invoice
    // The tx the service runs in: the same model mocks, plus a per-test raw query (the NULL-tenant line count).
    queryRaw = jest.fn().mockResolvedValue([]);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0), $queryRaw: queryRaw }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn(), getAll: jest.fn().mockResolvedValue({}), set: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
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
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn(), reserveNextTx: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const draft = {
    id: "inv-1",
    orderId: null as string | null,
    tenantId: "test-tenant",
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-0099",
    status: InvoiceStatus.DRAFT,
    subtotal: 100,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 100,
    notes: null,
    terms: null,
    dueDate: null,
    issueDate: new Date(),
  };
  const row = (o: Record<string, unknown> = {}) => ({
    id: "item-1",
    description: "Widget",
    qty: 1,
    unitPrice: 100,
    discount: 0,
    subtotal: 100,
    taxRate: 0,
    categoryTaxAmount: 0,
    ...o,
  });

  /** Stored invoice + its lines, as the locked tx reads them. */
  const arrange = (
    invoice: Record<string, unknown>,
    lines: Record<string, unknown>[],
    opts: { exempt?: boolean; payments?: Record<string, unknown>[] } = {},
  ) => {
    prisma.invoice.findUnique.mockResolvedValue({ ...draft, ...invoice });
    prisma.invoiceItem.findMany.mockResolvedValue(lines);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: !!opts.exempt });
    prisma.invoicePayment.findMany.mockResolvedValue(opts.payments ?? []);
    prisma.invoice.update.mockResolvedValue({ ...draft, ...invoice });
    prisma.order.findFirst.mockResolvedValue({ lineItems: [] }); // units_v1 guard reads the linked order
  };
  const written = () => prisma.invoice.update.mock.calls[0][0].data;

  // A $100 invoice whose one line carries a $5 levy: stored total 105.
  const withLevy = () =>
    arrange({ subtotal: 100, taxAmount: 5, total: 105 }, [row({ categoryTaxAmount: 5 })]);

  it("REG-B405: a discount of 2 gives 103 (levy kept), not the levy-less 98", async () => {
    withLevy();
    await service.update("inv-1", { discount: 2 });
    expect(written().total).not.toBe(98);
    expect(written()).toMatchObject({ discount: 2, total: 103 });
  });

  it("REG-B405: a shipping fee of 10 gives 115 (levy kept), not the levy-less 110", async () => {
    withLevy();
    await service.update("inv-1", { shippingFee: 10 });
    expect(written().total).not.toBe(110);
    expect(written()).toMatchObject({ shippingFee: 10, total: 115 });
  });

  it("REG-B405: discount 2 and shipping 10 together give 113", async () => {
    withLevy();
    await service.update("inv-1", { discount: 2, shippingFee: 10 });
    expect(written().total).toBe(113);
  });
});
