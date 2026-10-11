/**
 * B1030: update() accepted an invoice-level discount larger than the subtotal (PATCH {discount: 100} on a
 * $10 invoice stored total -90). create() refuses it with two checks (discount > subtotal, total < 0);
 * update() ran neither, on EITHER of its paths (the items rewrite, and the discount/shipping-only
 * recompute). Both now run the same shared assertInvoiceTotalsSane with create()'s code and messages. A
 * dedicated file: invoices.service.spec.ts sits at its size-ratchet ceiling.
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

describe("InvoicesService.update() — B1030 the invoice discount cannot exceed the subtotal on edit, like create()", () => {
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
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            syncInvoiceEntries: jest.fn(),
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

  const OVER = (d: number, s: number) =>
    `Invoice discount ($${d.toFixed(2)}) cannot exceed subtotal ($${s.toFixed(2)}).`;

  const items = (rows: Record<string, unknown>[]) => rows;
  const arrangeRecalc = (
    stored: Record<string, unknown>[],
    invoice: Record<string, unknown> = {},
  ) => {
    // B1043 (F1): the header-only PATCH trusts the stored header only when it matches the lines, so the
    // stored subtotal is the lines' sum (and the tax 0: every fixture line is rate 0). total = subtotal.
    const sum = stored.reduce((t, r) => t + Number(r.subtotal), 0);
    prisma.invoice.findUnique.mockResolvedValue({
      ...draftInvoice,
      subtotal: sum,
      total: sum,
      ...invoice,
    });
    prisma.invoiceItem.findMany.mockResolvedValue(items(stored));
    prisma.invoice.update.mockResolvedValue(draftInvoice);
  };
  const arrangeEdit = (invoice: Record<string, unknown> = {}) => {
    prisma.invoice.findUnique.mockResolvedValue({ ...draftInvoice, ...invoice });
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.update.mockResolvedValue(draftInvoice);
  };
  const noWrites = () => {
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
  };

  describe("the discount/shipping-only path", () => {
    it("(a) PATCH {discount: 100} on a $10 invoice is refused with create()'s message and writes nothing", async () => {
      arrangeRecalc([{ subtotal: 10, taxRate: 0 }]);
      const run = service.update("inv-box", { discount: 100 });
      await expect(run).rejects.toThrow(OVER(100, 10));
      await expect(run).rejects.toMatchObject({ status: 400 });
      noWrites();
    });

    // SA-651 NOT-WORSE rule: a legacy invoice that is already insane (stored discount 80 over a $10
    // subtotal, total -70) may still be saved when the edit does not make it worse.
    const LEGACY = { discount: 80, subtotal: 10, total: -70 };

    it("(b) a shipping-only PATCH on a LEGACY invoice (stored discount 80 over a $10 subtotal) SAVES: the total goes up, nothing gets worse", async () => {
      arrangeRecalc([{ subtotal: 10, taxRate: 0 }], LEGACY);
      await service.update("inv-box", { shippingFee: 5 });
      expect(prisma.invoice.update.mock.calls[0][0].data.total).toBe(-65);
    });

    it("(b2) the same legacy invoice with a BIGGER discount is refused: discount minus subtotal goes up", async () => {
      arrangeRecalc([{ subtotal: 10, taxRate: 0 }], LEGACY);
      await expect(service.update("inv-box", { discount: 90 })).rejects.toThrow(OVER(90, 10));
      noWrites();
    });

    it("(b3) a legacy invoice whose discount is LOWERED (still above the subtotal) saves: an improvement", async () => {
      arrangeRecalc([{ subtotal: 10, taxRate: 0 }], LEGACY);
      await service.update("inv-box", { discount: 60 });
      expect(prisma.invoice.update.mock.calls[0][0].data.total).toBe(-50);
    });

    it("(c) control: a discount equal to the subtotal saves, total = shipping + tax only (0 here)", async () => {
      arrangeRecalc([{ subtotal: 10, taxRate: 0 }]);
      await service.update("inv-box", { discount: 10 });
      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.discount).toBe(10);
      expect(data.total).toBe(0);
    });

    it("(d) control: a discount below the subtotal saves with the right total", async () => {
      arrangeRecalc([{ subtotal: 50, taxRate: 0 }]);
      await service.update("inv-box", { discount: 20 });
      expect(prisma.invoice.update.mock.calls[0][0].data.total).toBe(30);
    });
  });

  describe("the items-rewrite path", () => {
    it("(e) new lines totalling $10 with discount 100 are refused and nothing is written", async () => {
      arrangeEdit();
      const run = service.update("inv-box", {
        items: [{ description: "Widget", qty: 1, unitPrice: 10 }],
        discount: 100,
      });
      await expect(run).rejects.toThrow(OVER(100, 10));
      noWrites();
    });

    it("(f) a SANE invoice whose lines are edited DOWN below its stored discount is refused (stored discount 80 over $100, lines now $10)", async () => {
      arrangeEdit({ discount: 80, subtotal: 100, total: 20 });
      await expect(
        service.update("inv-box", { items: [{ description: "Widget", qty: 1, unitPrice: 10 }] }),
      ).rejects.toThrow(OVER(80, 10));
      noWrites();
    });

    it("(f2) a LEGACY invoice (stored discount 80 over $10, total -70) whose lines are edited UP to $50 saves: it improves", async () => {
      arrangeEdit({ discount: 80, subtotal: 10, total: -70 });
      await service.update("inv-box", {
        items: [{ description: "Widget", qty: 1, unitPrice: 50 }],
      });
      expect(prisma.invoice.update.mock.calls[0][0].data.total).toBe(-30);
    });

    it("(g) control: the same lines with a discount of 10 save", async () => {
      arrangeEdit();
      await service.update("inv-box", {
        items: [{ description: "Widget", qty: 1, unitPrice: 10 }],
        discount: 10,
      });
      expect(prisma.invoice.update.mock.calls[0][0].data.total).toBe(0);
    });
  });
});
