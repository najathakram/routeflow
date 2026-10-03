/**
 * B1026: update() stored a NEGATIVE line subtotal (1 x $5 with a $50 line discount saved -45 and
 * lowered the invoice total) because only create() ran assertNoNegativeLineSubtotal. update() now
 * runs the SAME guard over the lines THIS edit writes, before any write, with create()'s code and
 * message. A dedicated file: invoices.service.spec.ts sits at its size-ratchet ceiling.
 */

// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("InvoicesService.update() — B1026 a negative line subtotal is refused, like create()", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockNumbering = {
    reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
    reserveNextTx: jest.fn().mockResolvedValue("INV-2026-0001"),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // units_v1 guard reads the parent invoice

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
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
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
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const draftInvoice = {
    id: "inv-box",
    orderId: null,
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-0099",
    status: InvoiceStatus.DRAFT,
    subtotal: 0,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 0,
    notes: null,
    terms: null,
    dueDate: null,
    issueDate: new Date(),
  };

  const NEG = (d: string, s: number) =>
    `Line item "${d}" has a negative subtotal (${s}). Discount cannot exceed line total.`;

  const arrange = (stored: Record<string, unknown>[] = []) => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoice);
    prisma.invoiceItem.findMany.mockResolvedValue(stored);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
  };
  const noWrites = () => {
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
  };

  it("(a) a NEW line of 1 x $5 with a $50 line discount is refused with create()'s message, and nothing is written", async () => {
    arrange();
    const run = service.update("inv-box", {
      items: [{ description: "Widget", qty: 1, unitPrice: 5, discount: 50 }],
    });
    await expect(run).rejects.toThrow(NEG("Widget", -45));
    await expect(run).rejects.toMatchObject({ status: 400 });
    noWrites();
  });

  it("(b) the SAME refusal for an existing line edited down: stored 1 x $50 changed to a $50 discount", async () => {
    arrange([
      {
        id: "item-1",
        productId: null,
        description: "Widget",
        qty: 1,
        unitPrice: 50,
        discount: 0,
        subtotal: 50,
        taxRate: 0,
      },
    ]);
    const run = service.update("inv-box", {
      items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 5, discount: 50 }],
    });
    await expect(run).rejects.toThrow(NEG("Widget", -45));
    noWrites();
  });

  it("(c) one bad line among good ones refuses the whole save", async () => {
    arrange();
    const run = service.update("inv-box", {
      items: [
        { description: "Fine", qty: 2, unitPrice: 10 },
        { description: "Over-discounted", qty: 1, unitPrice: 5, discount: 50 },
      ],
    });
    await expect(run).rejects.toThrow(NEG("Over-discounted", -45));
    noWrites();
  });

  it("(d) control: a discount that leaves a positive subtotal saves, and the line stores 40", async () => {
    arrange();
    await service.update("inv-box", {
      items: [{ description: "Widget", qty: 1, unitPrice: 50, discount: 10 }],
    });
    const data = prisma.invoice.update.mock.calls[0][0].data;
    expect(data.items.create[0].subtotal).toBe(40);
    expect(data.subtotal).toBe(40);
  });

  it("(e) a discount exactly equal to the line total (subtotal 0) is allowed, as in create()", async () => {
    arrange();
    await service.update("inv-box", {
      items: [{ description: "Widget", qty: 1, unitPrice: 5, discount: 5 }],
    });
    expect(prisma.invoice.update.mock.calls[0][0].data.items.create[0].subtotal).toBe(0);
  });

  it("(f) scope: a stored line this edit does NOT touch is not re-judged (only the lines the edit writes)", async () => {
    arrange([
      {
        id: "legacy",
        productId: null,
        description: "Legacy",
        qty: 1,
        unitPrice: 5,
        discount: 50,
        subtotal: -45,
        taxRate: 0,
      },
    ]);
    await expect(
      service.update("inv-box", {
        items: [
          { id: "legacy", description: "Legacy", qty: 1, unitPrice: 5, discount: 50 },
          { description: "New", qty: 1, unitPrice: 10 },
        ],
      }),
    ).resolves.toBeDefined();
  });
});
