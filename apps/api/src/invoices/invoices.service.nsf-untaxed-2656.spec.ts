/**
 * #2656 / SA-549 — the NSF bounce-fee line is never taxed: invoice create() and the PATCH edit refuse
 * an NSF line with a tax rate > 0 (400 NSF_LINE_UNTAXED) before any write; 0 saves; goods lines are
 * untouched.
 *
 * Own file (not added to invoices.service.spec.ts) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is one of the 15 tracked giants and may not grow).
 * Same bootstrap pattern as the main spec file; duplicated deliberately rather than shared, so
 * this file stays self-contained and small.
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { NSF_FEE_DESCRIPTION_PREFIX } from "@routeflow/pricing";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("InvoicesService — #2656 the NSF line is never taxed", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
  };
  const mockEmailService = {
    sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };
  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };
  const mockNumbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // #2070: createPartialFromOrder's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: mockCreditNotes },
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const draft = {
    id: "inv-nsf",
    orderId: null,
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-0100",
    status: InvoiceStatus.DRAFT,
    subtotal: 125,
    taxAmount: 7.5,
    discount: 0,
    shippingFee: 0,
    total: 132.5,
    notes: null,
    terms: null,
    dueDate: null,
    issueDate: new Date(),
  };
  const NSF_DESC = `${NSF_FEE_DESCRIPTION_PREFIX} #7`;
  const storedGoods = {
    id: "li-goods",
    invoiceId: "inv-nsf",
    productId: null,
    description: "Cola 12pk",
    systemKind: null,
    qty: 1,
    unitPrice: 100,
    subtotal: 100,
    taxRate: 0.075,
    discount: 0,
  };
  const storedNsf = {
    id: "li-nsf",
    invoiceId: "inv-nsf",
    productId: null,
    description: NSF_DESC,
    systemKind: "NSF_FEE",
    qty: 1,
    unitPrice: 25,
    subtotal: 25,
    taxRate: 0,
    discount: 0,
  };
  const payload = (nsfTaxRate: number, goodsTaxRate = 0.075) => ({
    items: [
      { id: "li-goods", description: "Cola 12pk", qty: 1, unitPrice: 100, taxRate: goodsTaxRate },
      { id: "li-nsf", description: NSF_DESC, qty: 1, unitPrice: 25, taxRate: nsfTaxRate },
    ],
  });
  const arrange = () => {
    prisma.invoice.findUnique.mockResolvedValue(draft);
    prisma.invoiceItem.findMany.mockResolvedValue([storedGoods, storedNsf]);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draft);
  };
  const codeOf = (e: any) => (e?.getResponse?.() as any)?.code;

  it("update(): the stored NSF line given a rate > 0 ⇒ 400 NSF_LINE_UNTAXED, nothing written", async () => {
    arrange();
    const caught: any = await service.update("inv-nsf", payload(0.08) as any).catch((e) => e);
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(codeOf(caught)).toBe("NSF_LINE_UNTAXED");
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
  });

  it("update(): the NSF line at 0 saves beside a goods line at 7.5% — a goods rate is never refused", async () => {
    arrange();
    await service.update("inv-nsf", payload(0) as any);
    expect(prisma.invoice.update).toHaveBeenCalled();
  });

  it("update(): a NEW line described as the NSF fee with a rate > 0 ⇒ 400 (the prefix leg)", async () => {
    arrange();
    const body = {
      items: [
        ...payload(0).items,
        { description: `${NSF_FEE_DESCRIPTION_PREFIX} #8`, qty: 1, unitPrice: 25, taxRate: 0.05 },
      ],
    };
    const caught: any = await service.update("inv-nsf", body as any).catch((e) => e);
    expect(codeOf(caught)).toBe("NSF_LINE_UNTAXED");
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("update(): the stored row decides — a payload that renames the NSF line keeps it the NSF line", async () => {
    arrange();
    const body = payload(0.08);
    (body.items[1] as any).description = "Service charge";
    const caught: any = await service.update("inv-nsf", body as any).catch((e) => e);
    expect(codeOf(caught)).toBe("NSF_LINE_UNTAXED");
  });

  it("create(): an NSF-described line with a rate > 0 ⇒ 400 before any read or write", async () => {
    const caught: any = await service
      .create({
        customerId: "cust-1",
        items: [{ description: NSF_DESC, qty: 1, unitPrice: 25, taxRate: 0.08 }],
      } as any)
      .catch((e) => e);
    expect(codeOf(caught)).toBe("NSF_LINE_UNTAXED");
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
});
