// SA-1141 / W-989 PR-2, case 13 ("generate the invoice") and SA-1153 rows 6-9: the four order-to-invoice GENERATION sites stamp the
// line tax rate off the ORDER's discount mode (R4), never the new-document mode. Each site is driven through its real public method
// with the cutover SET by the harness (a past instant, so the real clock is after it: a swap to `newDocumentDiscountMode()` flips a
// LEGACY order to PRE_TAX). Fixture: 100 @10%, order discount 20. LEGACY order tax 10 (rate 10 / 100); the same stored tax read as
// PRE_TAX would be rate 10 / 80. Every row asserts the two things SA-1153 names: the fixture discriminates, and the stamped rate and
// invoice tax of a LEGACY order equal the same call with the cutover NULL (no figure typed). Own file: size ratchets.
import {
  AFTER,
  BEFORE,
  FIXTURE,
  expectFixtureDiscriminates,
  underCutover,
  withDiscountCutover,
} from "../common/testing/discount-cutover";

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { effectiveTaxRateFromTotals } from "../common/tax-rate";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

const orderLine = () => ({
  id: "oi-1",
  productId: "p-1",
  qty: 10,
  invoicedQty: 0,
  deliveredQty: 10,
  boxes: 10,
  pieces: 0,
  unitsPerBox: 1,
  unitPrice: 10,
  subtotal: 100,
  status: "PENDING",
  promoFreeUnits: null,
  categoryTaxAmount: 0,
  categoryTaxType: null,
  categoryTaxRate: null,
  categoryPriceIncludesTax: null,
  unitLabel: null,
  originalPrice: null,
  overrideReason: null,
  overriddenBy: null,
  priceType: "STANDARD",
  name: null,
  notes: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  product: { name: "Widget", unitsPerBox: 1 },
});

// A stored order: 100 less discount 20, with the tax the named mode levied on it.
const orderOf = (createdAt: Date, tax: number) => ({
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "CONFIRMED",
  createdAt,
  orderDate: null,
  subtotal: 100,
  discountAmount: 20,
  tax,
  shippingFee: 0,
  lineItems: [orderLine()],
});

describe("case 13 / SA-1153 rows 6-9: the four invoice generation sites stamp the ORDER's mode (SA-1141 R4)", () => {
  withDiscountCutover();
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
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
            writeSaleEntries: jest.fn().mockResolvedValue(undefined),
            reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
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
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
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
          useValue: {
            reserveNext: jest.fn().mockResolvedValue("INV-2026-0001"),
            reserveNextTx: jest.fn().mockResolvedValue("INV-2026-0001"),
          },
        },
      ],
    }).compile();
    service = module.get(InvoicesService);
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false } as any);
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ ...args.data, id: "inv-1", items: [], payments: [], customer: {} }),
    );
    prisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve({ id: "d1", items: args.data?.items?.create ?? [] }),
    );
    prisma.invoiceItem.deleteMany.mockResolvedValue({});
    prisma.orderItem.update.mockResolvedValue({});
  });

  const rates = (items: any[]): number[] => items.map((it) => Number(it.taxRate));
  // Σ line.subtotal * line.taxRate: what the next price adjustment recomputes the invoice's regular tax from.
  const stampedTax = (items: any[]): number =>
    Math.round(items.reduce((s, it) => s + Number(it.subtotal) * Number(it.taxRate), 0) * 100) /
    100;

  // site 1182 (createSplitInvoices), reached by createInvoiceFromOrderWithTenant
  const generate = async (order: any) => {
    prisma.order.findFirst.mockResolvedValue(order);
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    await service.createInvoiceFromOrderWithTenant("ord-1", "t-1");
    return prisma.invoice.create.mock.calls[0][0].data.items.create;
  };

  // site 2722 (createPartialFromOrder)
  const partial = async (order: any) => {
    prisma.order.findUnique.mockResolvedValue(order);
    await service.createPartialFromOrder("ord-1", {
      items: [{ orderItemId: "oi-1", qty: 10 }],
    } as any);
    return prisma.invoice.create.mock.calls[0][0].data.items.create;
  };

  // site 1648 (reconcileOrderDraftInvoiceLocked, the single-draft branch)
  const reconcileDraft = async (order: any) => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: "d1", status: InvoiceStatus.DRAFT, deliveryBatchId: null, discount: 0, items: [] },
    ]);
    prisma.invoice.findFirst.mockResolvedValue({ id: "d1", discount: 0, shippingFee: 0 });
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.orderItem.findMany.mockResolvedValue([{ id: "oi-1" }]);
    await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
    return prisma.invoice.update.mock.calls[0][0].data.items.create;
  };

  // site 2036 (rebuildSiblingDrafts), reached by reconcileOrderDeliveredInvoices
  const reconcileSiblings = async (order: any) => {
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "d1",
        status: InvoiceStatus.DRAFT,
        deliveryBatchId: null,
        discount: 0,
        shippingFee: 0,
        items: [{ orderItemId: "oi-1", unitsPerBox: 1 }],
      },
    ]);
    prisma.order.findUnique.mockResolvedValue(order);
    await service.reconcileOrderDeliveredInvoices("ord-1");
    return prisma.invoice.update.mock.calls[0][0].data.items.create;
  };

  const sites: Array<[string, (o: any) => Promise<any[]>]> = [
    ["invoices.service.ts:1182 createInvoiceFromOrderWithTenant", generate],
    ["invoices.service.ts:1648 reconcileOrderDraftInvoice", reconcileDraft],
    ["invoices.service.ts:2036 reconcileOrderDeliveredInvoices", reconcileSiblings],
    ["invoices.service.ts:2722 createPartialFromOrder", partial],
  ];

  /** The stamped rate(s) and the invoice tax they reproduce, from a clean slate of recorded writes. */
  const figures = async (run: (o: any) => Promise<any[]>, order: any) => {
    prisma.invoice.create.mockClear();
    prisma.invoice.update.mockClear();
    const items = await run(order);
    return { rates: rates(items), tax: stampedTax(items) };
  };

  describe.each(sites)("%s", (_name, run) => {
    it("a LEGACY order (made BEFORE the cutover) invoiced NOW stamps the rate and invoice tax of the cutover-null run", async () => {
      expectFixtureDiscriminates();
      const dark = await underCutover(null, () => figures(run, orderOf(BEFORE, 10))); // master's figure
      // 1: the same stored order read as a PRE_TAX one (dated AFTER) stamps a different rate: a swap to the new-document mode shows here
      expect(await figures(run, orderOf(AFTER, 10))).not.toEqual(dark);
      // 2: the LEGACY order, cutover set, equals the cutover-null run
      expect(await figures(run, orderOf(BEFORE, 10))).toEqual(dark);
    });

    it("a PRE_TAX order (made AFTER the cutover, tax levied on the discounted base) stamps the rate that base implies", async () => {
      const rate = effectiveTaxRateFromTotals(8, FIXTURE.subtotal, false, {
        discount: FIXTURE.discount,
        discountBase: "PRE_TAX",
      });
      const got = await figures(run, orderOf(AFTER, 8));
      expect(got.rates).toEqual([rate]);
    });
  });
});
