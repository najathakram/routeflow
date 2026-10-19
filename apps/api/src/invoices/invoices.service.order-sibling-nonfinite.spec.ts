// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

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
import { InvoiceStatus, Prisma } from "@prisma/client";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-816: `recomputeOrderFromInvoices` runs AFTER an invoice edit commits and refuses a stored non-finite
 * amount on ANY non-void invoice of the order. Without a look-ahead, an edit of invoice A whose SIBLING B
 * carries a NaN levy committed A and then answered 400: the save looked failed while A was saved and the
 * order was out of step. The look-ahead (`preflightOrderSiblings`, the same guarded aggregation) now runs
 * before the first write of each edit flow, so the refusal leaves NOTHING written on A.
 *
 * Master (static read, not run): each call below resolved after writing A (items update, header update,
 * item updates) and the post-commit order sync then threw MONEY_INVARIANT.
 */
describe("SA-816: a NaN sibling invoice refuses an order-linked edit before anything is written", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let rows: Array<Record<string, any>>;

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
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn(), reserveNextTx: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  const line = (id: string, subtotal: number, taxRate: number) => ({
    id,
    productId: null,
    description: "Widget",
    qty: 1,
    unitPrice: subtotal,
    subtotal,
    discount: 0,
    taxRate,
    categoryTaxAmount: 0,
  });

  /** Invoice A on order ord-1 (a consistent $100 at 7.5%), plus the order and its sibling invoice B. */
  const withOrderAndSibling = (status: InvoiceStatus, siblingLevy: unknown) => {
    rows = [line("li-1", 100, 0.075)];
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      orderId: "ord-1",
      customerId: "cust-1",
      status,
      discount: 0,
      shippingFee: 0,
      dueDate: null,
      payments: [],
      subtotal: 100,
      taxAmount: 7.5,
      total: 107.5,
      items: rows.map((r) => ({ ...r })),
    });
    prisma.invoice.update.mockResolvedValue({ id: "inv-1", items: [] });
    prisma.invoice.count.mockResolvedValue(2);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoiceItem.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
    // the guards that read the parent order (not mirrored, not shipped, no unit-aware lines)
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      status: "DELIVERED",
      orderNumber: 1,
      fulfillPath: null,
      shippedAt: null,
      tenantId: "test-tenant",
      lineItems: [],
    });
    // the preflight's reads: the order with its lines, and the OTHER non-void invoices
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      lineItems: [{ id: "oi-1", productId: "p-1", status: "PENDING" }],
    });
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv-2",
        orderId: "ord-1",
        items: [
          {
            id: "b-1",
            orderItemId: "oi-1",
            productId: "p-1",
            qty: 1,
            unitPrice: 10,
            subtotal: 10,
            unitsPerBox: null,
            categoryTaxAmount: siblingLevy,
          },
        ],
      },
    ]);
  };

  const nothingWritten = () => {
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.create).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  };
  const MONEY = { status: 400, response: { code: API_ERROR_CODES.MONEY_INVARIANT } };
  const SIBLING_NAN: ReadonlyArray<[string, unknown]> = [
    ["the string 'NaN'", "NaN"],
    ["Prisma.Decimal('NaN')", new Prisma.Decimal("NaN")],
    ["the string 'Infinity'", "Infinity"],
  ];

  describe.each(SIBLING_NAN)("sibling levy %s", (_label, nan) => {
    it("DRAFT items update: 400 MONEY_INVARIANT and nothing written on A", async () => {
      withOrderAndSibling(InvoiceStatus.DRAFT, nan);
      await expect(
        service.update("inv-1", {
          items: [{ id: "li-1", description: "Widget", qty: 1, unitPrice: 95, taxRate: 0.075 }],
        }),
      ).rejects.toMatchObject(MONEY);
      nothingWritten();
    });

    it("header discount / shipping PATCH: 400 MONEY_INVARIANT and nothing written on A", async () => {
      withOrderAndSibling(InvoiceStatus.DRAFT, nan);
      await expect(service.update("inv-1", { discount: 5 })).rejects.toMatchObject(MONEY);
      nothingWritten();
    });

    it("SINGLE price adjustment: 400 MONEY_INVARIANT and nothing written on A", async () => {
      withOrderAndSibling(InvoiceStatus.SENT, nan);
      await expect(
        service.applyPriceAdjustment("inv-1", {
          items: [{ itemId: "li-1", newUnitPrice: 95 }],
          scope: "SINGLE",
        }),
      ).rejects.toMatchObject(MONEY);
      nothingWritten();
    });
  });

  describe("controls: a finite sibling lets each flow write as before", () => {
    it("DRAFT items update writes A", async () => {
      withOrderAndSibling(InvoiceStatus.DRAFT, "2.00");
      jest.spyOn(service, "recomputeOrderFromInvoices").mockResolvedValue(null as any);
      await service.update("inv-1", {
        items: [{ id: "li-1", description: "Widget", qty: 1, unitPrice: 95, taxRate: 0.075 }],
      });
      expect(prisma.invoice.update).toHaveBeenCalled();
    });

    it("header PATCH writes A", async () => {
      withOrderAndSibling(InvoiceStatus.DRAFT, null);
      jest.spyOn(service, "recomputeOrderFromInvoices").mockResolvedValue(null as any);
      await service.update("inv-1", { discount: 5 });
      expect(prisma.invoice.update).toHaveBeenCalled();
    });

    it("SINGLE price adjustment writes A", async () => {
      withOrderAndSibling(InvoiceStatus.SENT, 0);
      jest.spyOn(service, "recomputeOrderFromInvoices").mockResolvedValue(null as any);
      await service.applyPriceAdjustment("inv-1", {
        items: [{ itemId: "li-1", newUnitPrice: 95 }],
        scope: "SINGLE",
      });
      expect(prisma.invoice.update).toHaveBeenCalled();
    });
  });

  it("A's own stored values are not the preflight's business: the edited invoice is excluded from the read", async () => {
    withOrderAndSibling(InvoiceStatus.DRAFT, 0);
    jest.spyOn(service, "recomputeOrderFromInvoices").mockResolvedValue(null as any);
    await service.update("inv-1", { discount: 5 });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "inv-1" } }),
      }),
    );
  });
});
