/**
 * B661/B671 — the ledger derives unit basis from a line's own stored shape.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("InvoicesService — B661/B671", () => {
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
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  describe("create()", () => {
    // B661 spec (5)/(6): the recurring-invoice generator creates its invoices through THIS
    // create() method (recurring-invoices.service.ts calls invoicesService.create — no separate
    // ledger write path exists for it), so proving create() plumbs a box-unaware line's pack
    // through to writeSaleEntries proves the recurring generator books true pieces too.
    it("B661: create() resolves packAtSale from the LIVE product for a box-unaware regulated line (feeds the ledger's unit-basis expansion)", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-tob2",
          unitsPerBox: 12,
          trackedCategoryId: "cat-tob",
          trackedSubcategoryId: null,
        },
      ]);
      prisma.invoice.create.mockResolvedValue({
        id: "inv-recurring",
        items: [
          {
            id: "ii-1",
            productId: "prod-tob2",
            trackedCategoryId: "cat-tob",
            trackedSubcategoryId: null,
            orderItemId: null,
            qty: 5,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitLabel: null,
            subtotal: 50,
            categoryTaxAmount: 10,
          },
        ],
        customer: {},
        payments: [],
      });
      const ledger = (service as any).ledger;

      await service.create({
        customerId: "cust-1",
        items: [{ productId: "prod-tob2", description: "Cigs (case)", qty: 5, unitPrice: 10 }],
      });

      expect(ledger.writeSaleEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: [
            expect.objectContaining({
              invoiceItemId: "ii-1",
              qty: 5,
              boxes: null,
              pieces: null,
              packAtSale: 12, // the LIVE product's unitsPerBox, resolved by the caller at write time
            }),
          ],
        }),
      );
    });
  });

  describe("duplicate()", () => {
    // B661 spec (5), DOCUMENTING not red-first: duplicate() copies each line's boxes/pieces/
    // unitsPerBox verbatim (so it WOULD book the same unitBasisQty as the original, same as any
    // other writeSaleEntries caller), but it never calls the ledger at all — a pre-existing gap,
    // separate from the unit-basis question this PR converts. Senior Architect ruling
    // 2026-09-21: pin today's actual (gap) behavior here rather than silently adding a ledger
    // write to a method that doesn't have one; "duplicate() never re-establishes ledger rows for
    // the copy" is filed as its own follow-up bug (regulated, high) — see the PR body.
    it("B661/B680: duplicate() copies a regulated line's boxes/pieces/unitsPerBox verbatim and (B680) writes the copy's own ledger rows", async () => {
      const baseInv = {
        id: "inv-reg",
        orderId: null,
        customerId: "cust-1",
        invoiceNumber: "INV-2026-0005",
        status: InvoiceStatus.SENT,
        subtotal: 60,
        taxAmount: 0,
        discount: 0,
        shippingFee: 0,
        total: 60,
        notes: null,
        terms: null,
        items: [
          {
            id: "ii-src",
            productId: "prod-tob",
            trackedCategoryId: "cat-tob",
            trackedSubcategoryId: null,
            qty: 5,
            boxes: null,
            pieces: null,
            unitsPerBox: 12,
            unitPrice: 12,
            discount: 0,
            taxRate: 0,
            subtotal: 60,
            categoryTaxAmount: 0,
          },
        ],
      };
      prisma.invoice.findUnique.mockResolvedValue(baseInv);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.create.mockResolvedValue({ ...baseInv, id: "inv-copy" });
      const ledger = (service as any).ledger;

      await service.duplicate("inv-reg");

      // The copy's line data carries the same shape the original had (boxes/pieces/unitsPerBox
      // travel verbatim) — the DATA is there for a correct unitBasisQty if the ledger were ever
      // wired in.
      const copyItem = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
      expect(copyItem).toMatchObject({ qty: 5, boxes: null, pieces: null, unitsPerBox: 12 });
      // B680 closed the gap this test used to pin: the copy now books its own SALE rows.
      expect(ledger.writeSaleEntries).toHaveBeenCalledTimes(1);
      expect(ledger.writeSaleEntries.mock.calls[0][0]).toMatchObject({
        invoiceId: "inv-copy",
        orderId: null,
      });
    });
  });
});
