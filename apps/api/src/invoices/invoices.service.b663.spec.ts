/**
 * B663 — reconcileDeliveredOrdersInTx runs on EVERY delivery completion, whether or not
 * there is a payment. Extracted out of recordDeliveryPaymentInTx so an on-account (no
 * payment) completion — the ordinary case for most tenants — still rebuilds a short/
 * refused delivery's DRAFT (or SENT deposit) mirror onto what was actually delivered,
 * instead of leaving it at the full pre-delivery total.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is one of the 15 tracked giants and may not
 * grow). Same bootstrap pattern as the main spec file (and invoices.service.b661.spec.ts);
 * duplicated deliberately rather than shared, so this file stays self-contained and small.
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

describe("InvoicesService — B663", () => {
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

  // B663: extracted out of recordDeliveryPaymentInTx so it can run UNCONDITIONALLY on
  // every delivery completion — an on-account (no payment) completion used to skip
  // this entirely, leaving a short/refused delivery's DRAFT mirror at the full
  // ordered quantity. These are the same fixtures/assertions the extracted lines
  // carried inside recordDeliveryPaymentInTx's own describe block before the split.
  describe("reconcileDeliveredOrdersInTx (B663 — runs whether or not there is a payment)", () => {
    const inv = (over: any = {}) => ({
      id: "inv-1",
      total: 100,
      status: InvoiceStatus.SENT,
      dueDate: null,
      invoiceNumber: "INV-1",
      customerId: "cust-1",
      payments: [],
      ...over,
    });

    beforeEach(() => {
      jest.spyOn(service, "findOpenOrderDraft").mockResolvedValue(null as any);
      jest.spyOn(service, "reconcileOrderDeliveredInvoices").mockResolvedValue(undefined as any);
      jest.spyOn(service, "createInvoiceFromOrder").mockResolvedValue([] as any);
      prisma.invoice.update.mockResolvedValue({} as any);
    });

    it("creates a DRAFT when the order has none, then reconciles it on the DELIVERED basis", async () => {
      // No draft initially; one exists after createInvoiceFromOrder.
      (service.findOpenOrderDraft as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findFirst.mockResolvedValue(null); // no live invoice at all

      await service.reconcileDeliveredOrdersInTx(prisma as any, ["ord-1"]);

      expect(service.createInvoiceFromOrder).toHaveBeenCalledWith("ord-1", prisma);
      // Sibling-aware delivered reconcile is what makes a short-pick bill delivered.
      expect(service.reconcileOrderDeliveredInvoices).toHaveBeenCalledWith("ord-1", prisma);
    });

    it("reconciles an EXISTING draft on the delivered basis (no re-create)", async () => {
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-1" });

      await service.reconcileDeliveredOrdersInTx(prisma as any, ["ord-1"]);

      expect(service.reconcileOrderDeliveredInvoices).toHaveBeenCalledWith("ord-1", prisma);
      expect(service.createInvoiceFromOrder).not.toHaveBeenCalled(); // a draft already existed
    });

    it("reconciles a SPLIT-invoice order too (sibling-aware — no gate, no double-bill)", async () => {
      // A SEPARATE_INVOICE regulated order has base + -R# sibling drafts. The
      // sibling-aware reconcile rebuilds each from ITS OWN lines (proven in
      // reconcileOrderDeliveredInvoices's own describe block below), so it now
      // runs (the old invoiceCount<=1 skip is gone) without folding lines onto
      // the base. THIS layer's own guarantee is narrower — and is what the
      // assertion below actually proves: it delegates to
      // reconcileOrderDeliveredInvoices exactly ONCE per order, never once per
      // sibling invoice, which is what would double-bill (running the
      // sibling-aware rebuild redundantly against the same siblings).
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-base" });
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-base", invoiceNumber: "INV-9", total: 60 },
        { id: "inv-r1", invoiceNumber: "INV-9-R1", total: 40 },
      ]);

      await service.reconcileDeliveredOrdersInTx(prisma as any, ["ord-1"]);

      expect(service.reconcileOrderDeliveredInvoices).toHaveBeenCalledWith("ord-1", prisma);
      expect(service.reconcileOrderDeliveredInvoices).toHaveBeenCalledTimes(1);
    });

    // B2 (WP-D1): a deposit mirror issued at placement is SENT — there is no open
    // DRAFT to find, so the delivered-basis rebuild used to be skipped entirely and a
    // short delivery collected against the FULL pre-delivery total.
    it("rebuilds an ISSUED deposit mirror on the DELIVERED basis, preserving payments and recomputing status", async () => {
      // 10 units @ $100 = $1,000, issued SENT at placement with a 30% deposit ($300,
      // already paid). Only 6 are delivered → the bill must restate to $600.
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-dep" }); // a live invoice exists
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          invoiceNumber: "INV-DEP",
          customerId: "cust-1",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          depositPercent: 30,
          discount: 0,
          shippingFee: 0,
          dueDate: null,
          total: 1000,
          payments: [{ amount: 300, status: "PAID" }],
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "ord-1",
        customerId: "cust-1",
        subtotal: 1000,
        tax: 0,
        shippingFee: 0,
        lineItems: [
          {
            id: "li-1",
            productId: "p1",
            qty: 10,
            deliveredQty: 6,
            unitPrice: 100,
            subtotal: 1000,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "Widget" },
            status: "PENDING",
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({ id: "inv-dep", ...args.data, items: [] }),
      );
      // B785/SA-113a: the deposit-mirror rebuild now reads the evidence basis
      // (delivered-basis-by-line.ts), never li.deliveredQty — li-1's own evidence
      // row delivers 6 of the ordered 10.
      prisma.deliveryMutation.findMany.mockResolvedValue([
        { orderItemId: "li-1", type: "DELIVERED", quantityDelivered: 6 },
      ]);

      await service.reconcileDeliveredOrdersInTx(prisma as any, ["ord-1"]);

      const rebuild = prisma.invoice.update.mock.calls[0][0];
      expect(rebuild.where).toEqual({ id: "inv-dep" });
      expect(rebuild.data.subtotal).toBeCloseTo(600, 2); // 6 of 10 × $100
      expect(rebuild.data.total).toBeCloseTo(600, 2);
      // Payment rows are never written by the rebuild; status recomputes from the
      // $300 already paid against the NEW $600 total.
      expect("payments" in rebuild.data).toBe(false);
      expect(rebuild.data.status).toBe(InvoiceStatus.PARTIAL);
      // The DRAFT-only delivered reconcile can't run here — there is no draft.
      expect(service.reconcileOrderDeliveredInvoices).not.toHaveBeenCalled();
    });

    it("leaves a plain SENT invoice (no deposit) alone when there is no draft — the fence", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv({ deliveryBatchId: null })]);

      await service.reconcileDeliveredOrdersInTx(prisma as any, ["ord-1"]);

      // Only the payment-status update ran — no rebuild of a non-deposit invoice.
      expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
    });

    it("does NOT reconcile an order absent from reconcileOrderIds (not delivered this completion)", async () => {
      // An order merely linked to the stop but delivered elsewhere has deliveredQty
      // 0; reconciling it would zero its open draft.
      (service.findOpenOrderDraft as jest.Mock).mockReset().mockResolvedValue({ id: "inv-1" });

      await service.reconcileDeliveredOrdersInTx(prisma as any, ["ord-1"], []);

      expect(service.reconcileOrderDeliveredInvoices).not.toHaveBeenCalled();
    });
  });
});
