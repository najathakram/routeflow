/**
 * B667 round 5, item 3 — the void path's legacy product-match fallback never targets a
 * CANCELLED order line.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is one of the 15 tracked giants and may not grow;
 * it was already at its ceiling before this PR touched it). Same bootstrap pattern as the main
 * spec file (see invoices.service.b661.spec.ts); duplicated deliberately rather than shared, so
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("InvoicesService — B667 round 5", () => {
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

  // #1185 round 5, item 3: findMany returns the CANCELLED sibling FIRST -- deterministic, unlike
  // the Postgres-row-order-dependent DB repro; `.find()` alone would pick it sans the status
  // filter (review round 4's product-only fallback had no status guard at all).
  it("adjustInvoicedQtyForInvoice never targets a CANCELLED line, even when findMany returns it first", async () => {
    const c1 = { id: "c1", productId: "p1", status: "CANCELLED", qty: 0, invoicedQty: 0 };
    const a1 = { id: "a1", productId: "p1", status: "PENDING", qty: 4, invoicedQty: 4 };
    const update = jest.fn().mockResolvedValue({});
    const tx = {
      invoiceItem: { findMany: jest.fn().mockResolvedValue([{ productId: "p1", qty: 4 }]) },
      orderItem: { findMany: jest.fn().mockResolvedValue([c1, a1]), update },
    };

    await (service as any).adjustInvoicedQtyForInvoice(tx, "inv1", "order1", -1);

    expect(update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { invoicedQty: 0 } });
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1" } }));
  });

  // SA-093a ruling (2+3), round 6: "never silently" -- an ambiguous-product fallback skip (no
  // orderItemId on the invoice item, 2+ active lines share its product) must log a warn naming
  // the order, not just silently leave the lines untouched (round 5's original behavior).
  it("recomputeOrderFromInvoices warns when it skips an ambiguous-product fallback match, never silently", async () => {
    const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});
    const l1 = { id: "l1", productId: "p1", status: "PENDING", qty: 4, invoicedQty: 0 };
    const l2 = { id: "l2", productId: "p1", status: "PENDING", qty: 6, invoicedQty: 0 };
    const l3 = { id: "l3", productId: "p2", status: "PENDING", qty: 5, invoicedQty: 0 };
    prisma.order.findUnique.mockResolvedValue({
      id: "order1",
      status: "PENDING",
      subtotal: 150,
      tax: 0,
      total: 150,
      shippingFee: 0,
      lineItems: [l1, l2, l3],
    });
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv1",
        shippingFee: 0,
        items: [
          {
            orderItemId: null, // no provenance -- forces the product fallback
            productId: "p1", // shared by l1 AND l2 -- ambiguous
            qty: 6,
            subtotal: 60,
            categoryTaxAmount: 0,
            promoFreeUnits: 0,
            unitPrice: 10,
          },
        ],
      },
    ]);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    prisma.orderItem.update.mockResolvedValue({});
    prisma.order.update.mockResolvedValue({});

    await service.recomputeOrderFromInvoices("order1", prisma);

    const warned = warnSpy.mock.calls.some(
      (call) =>
        String(call[0]).includes("order1") &&
        String(call[0]).includes("l1") &&
        String(call[0]).includes("l2"),
    );
    expect(warned).toBe(true);
  });

  // Round 7, item 4 (LOW): the ambiguous-fallback warn above was the only spy test -- the
  // free-text-invoice-item skip (no orderItemId, no productId at all) has warned since round 6
  // but was never itself spy-tested.
  it("recomputeOrderFromInvoices warns when it skips a free-text invoice item, never silently", async () => {
    const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});
    const l1 = { id: "l1", productId: "p1", status: "PENDING", qty: 4, invoicedQty: 0 };
    prisma.order.findUnique.mockResolvedValue({
      id: "order1",
      status: "PENDING",
      subtotal: 40,
      tax: 0,
      total: 40,
      shippingFee: 0,
      lineItems: [l1],
    });
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv1",
        shippingFee: 0,
        items: [
          {
            id: "freetext1",
            orderItemId: null,
            productId: null, // no provenance AND no product -- genuinely freeform
            qty: 1,
            subtotal: 10,
            categoryTaxAmount: 0,
            promoFreeUnits: 0,
            unitPrice: 10,
          },
        ],
      },
    ]);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    prisma.orderItem.update.mockResolvedValue({});
    prisma.order.update.mockResolvedValue({});

    await service.recomputeOrderFromInvoices("order1", prisma);

    const warned = warnSpy.mock.calls.some(
      (call) => String(call[0]).includes("order1") && String(call[0]).includes("freetext1"),
    );
    expect(warned).toBe(true);
  });

  // B297 row 373 (review fold): the invoice -> order copier (C17) carries the invoice line's category, subcategory
  // and rate trio onto the order line it CREATES, like every other order <-> invoice copier. Without it the new
  // order line is uncategorised (373a removed the live-product fallback), and the next reconcile bills it
  // uncategorised, dropping a regulated line out of its SEPARATE_INVOICE group.
  it("recomputeOrderFromInvoices: a NEW order line made from an invoice line carries that line's category and trio", async () => {
    const l1 = { id: "l1", productId: "p1", status: "PENDING", qty: 4, invoicedQty: 0 };
    prisma.order.findUnique.mockResolvedValue({
      id: "order1",
      status: "PENDING",
      subtotal: 40,
      tax: 0,
      total: 40,
      shippingFee: 0,
      lineItems: [l1],
    });
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv1",
        shippingFee: 0,
        items: [
          {
            id: "ii-l1", // covers the existing order line, so the recompute runs (B667 coverage)
            orderItemId: "l1",
            productId: "p1",
            qty: 4,
            subtotal: 40,
            categoryTaxAmount: 0,
            promoFreeUnits: 0,
            unitPrice: 10,
          },
          {
            id: "ii-new",
            orderItemId: null,
            productId: "p9", // no order line matches: becomes a NEW order line
            qty: 3,
            subtotal: 30,
            categoryTaxAmount: 1.5,
            promoFreeUnits: 0,
            unitPrice: 10,
            trackedCategoryId: "cat-1",
            trackedSubcategoryId: "sub-1",
            categoryTaxType: "EXCISE_PER_UNIT",
            categoryTaxRate: "0.0500",
            categoryPriceIncludesTax: false,
          },
        ],
      },
    ]);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    prisma.orderItem.update.mockResolvedValue({});
    prisma.orderItem.create.mockResolvedValue({});
    prisma.order.update.mockResolvedValue({});

    await service.recomputeOrderFromInvoices("order1", prisma);

    const created = prisma.orderItem.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.productId === "p9");
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      trackedCategoryId: "cat-1",
      trackedSubcategoryId: "sub-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.05,
      categoryPriceIncludesTax: false,
      categoryTaxAmount: 1.5,
    });
  });

  it("recomputeOrderFromInvoices: invoice lines of one product billed under DIFFERENT trios become separate order lines", async () => {
    const l1 = { id: "l1", productId: "p1", status: "PENDING", qty: 4, invoicedQty: 0 };
    prisma.order.findUnique.mockResolvedValue({
      id: "order1",
      status: "PENDING",
      subtotal: 70,
      tax: 0,
      total: 70,
      shippingFee: 0,
      lineItems: [l1],
    });
    const base = {
      orderItemId: null,
      productId: "p9",
      categoryTaxAmount: 0,
      promoFreeUnits: 0,
      unitPrice: 10,
    };
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv1",
        shippingFee: 0,
        items: [
          {
            id: "ii-l1",
            orderItemId: "l1",
            productId: "p1",
            qty: 4,
            subtotal: 40,
            categoryTaxAmount: 0,
            promoFreeUnits: 0,
            unitPrice: 10,
          },
          {
            ...base,
            id: "a",
            qty: 2,
            subtotal: 20,
            trackedCategoryId: "cat-1",
            categoryTaxType: "EXCISE_PER_UNIT",
            categoryTaxRate: "0.0500",
            categoryPriceIncludesTax: false,
          },
          {
            ...base,
            id: "b",
            qty: 1,
            subtotal: 10,
            trackedCategoryId: "cat-1",
            categoryTaxType: "EXCISE_PER_UNIT",
            categoryTaxRate: "0.0800",
            categoryPriceIncludesTax: false,
          },
        ],
      },
    ]);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    prisma.orderItem.update.mockResolvedValue({});
    prisma.orderItem.create.mockResolvedValue({});
    prisma.order.update.mockResolvedValue({});

    await service.recomputeOrderFromInvoices("order1", prisma);

    const made = prisma.orderItem.create.mock.calls
      .map((c: any) => c[0].data)
      .filter((d: any) => d.productId === "p9");
    expect(made.map((d: any) => [d.qty, d.categoryTaxRate]).sort()).toEqual([
      [1, 0.08],
      [2, 0.05],
    ]);
  });

  it("recomputeOrderFromInvoices is idempotent for lines split by snapshot: a second recompute creates and cancels nothing", async () => {
    const trioA = {
      trackedCategoryId: "cat-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.05,
      categoryPriceIncludesTax: false,
    };
    const trioB = { ...trioA, categoryTaxRate: 0.08 };
    const l1 = {
      id: "l1",
      productId: "p1",
      status: "PENDING",
      qty: 4,
      invoicedQty: 0,
      unitPrice: 10,
      subtotal: 40,
    };
    // state AFTER the first recompute: the two snapshot lines exist; the invoice items still carry no orderItemId
    const made = [
      {
        id: "n1",
        productId: "p9",
        status: "PENDING",
        qty: 2,
        invoicedQty: 2,
        unitPrice: 10,
        subtotal: 20,
        ...trioA,
      },
      {
        id: "n2",
        productId: "p9",
        status: "PENDING",
        qty: 1,
        invoicedQty: 1,
        unitPrice: 10,
        subtotal: 10,
        ...trioB,
      },
    ];
    prisma.order.findUnique.mockResolvedValue({
      id: "order1",
      status: "PENDING",
      subtotal: 70,
      tax: 0,
      total: 70,
      shippingFee: 0,
      lineItems: [l1, ...made],
    });
    const base = {
      orderItemId: null,
      productId: "p9",
      categoryTaxAmount: 0,
      promoFreeUnits: 0,
      unitPrice: 10,
    };
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv1",
        shippingFee: 0,
        items: [
          {
            id: "ii-l1",
            orderItemId: "l1",
            productId: "p1",
            qty: 4,
            subtotal: 40,
            categoryTaxAmount: 0,
            promoFreeUnits: 0,
            unitPrice: 10,
          },
          { ...base, id: "a", qty: 2, subtotal: 20, ...trioA, categoryTaxRate: "0.0500" },
          { ...base, id: "b", qty: 1, subtotal: 10, ...trioB, categoryTaxRate: "0.0800" },
        ],
      },
    ]);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    prisma.orderItem.update.mockResolvedValue({});
    prisma.orderItem.create.mockResolvedValue({});
    prisma.orderItem.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.update.mockResolvedValue({});

    await service.recomputeOrderFromInvoices("order1", prisma);

    expect(prisma.orderItem.create).not.toHaveBeenCalled();
    const cancelled = prisma.orderItem.update.mock.calls.filter(
      (c: any) => c[0]?.data?.status === "CANCELLED",
    );
    expect(cancelled).toHaveLength(0);
  });
});
