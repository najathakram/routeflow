/**
 * SA-222 (LOW): a totals-only / untouched items save passes a changed-set to recomputeOrderFromInvoices, and
 * NO order line is written for a target outside it: neither an existing line (UPDATE) nor an invoice line
 * with no matching order line (CREATE). Own file: the main spec is at its size ratchet.
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

describe("recomputeOrderFromInvoices — the changed-set gates CREATE as well as UPDATE (SA-222)", () => {
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
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
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

  const orderLine = {
    id: "oi-1",
    productId: "p-1",
    status: "PENDING",
    qty: 5,
    invoicedQty: 5,
    unitPrice: 10,
    subtotal: 50,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
  };
  const invItem = (over: any = {}) => ({
    id: "ii-1",
    orderItemId: "oi-1",
    productId: "p-1",
    qty: 5,
    unitPrice: 10,
    subtotal: 50,
    categoryTaxAmount: 0,
    promoFreeUnits: null,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    ...over,
  });
  const extra = () =>
    invItem({ id: "ii-2", orderItemId: null, productId: "p-new", qty: 3, subtotal: 30 });
  const arrange = (items: any[]) => {
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "DELIVERED",
      subtotal: 50,
      tax: 0,
      shippingFee: 0,
      lineItems: [orderLine],
    });
    prisma.invoice.findMany.mockResolvedValue([{ id: "inv-1", status: "DRAFT", items }]);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    prisma.orderItem.update.mockResolvedValue({});
    prisma.orderItem.create.mockResolvedValue({});
  };
  const run = (changed?: any[]) =>
    (service as any).recomputeOrderFromInvoices("ord-1", prisma, changed);

  it("a totals-only save (empty changed-set) writes ZERO order lines, including for an invoice line with no order line (no CREATE)", async () => {
    arrange([invItem(), extra()]);
    await run([]);
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
  });

  it("a CHANGED invoice line with no order line still creates its order line", async () => {
    arrange([invItem(), extra()]);
    await run([{ orderItemId: null, productId: "p-new" }]);
    expect(prisma.orderItem.create).toHaveBeenCalledTimes(1);
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
  });

  it("the full recompute (no changed-set) still creates a missing order line, as before", async () => {
    arrange([invItem(), extra()]);
    await run(undefined);
    expect(prisma.orderItem.create).toHaveBeenCalledTimes(1);
  });
});
