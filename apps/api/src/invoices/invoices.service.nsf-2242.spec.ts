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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * #2242 (SA-395 5a) — reconcileOrderDraftInvoice on an ISSUED deposit mirror keeps the invoice's
 * system NSF fee lines through its delete-and-rebuild and adds the fee AFTER the tax proration.
 * Its own file: invoices.service.spec.ts is at its size-ratchet ceiling.
 */
describe("#2242 — an order rebuild keeps the NSF fee line", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

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
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: { sendInvoice: jest.fn() } },
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
          useValue: { autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }) },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  const depositOrder = {
    id: "o-dep",
    customerId: "c1",
    subtotal: 50,
    tax: 5,
    lineItems: [
      {
        id: "li1",
        productId: "p1",
        qty: 10,
        deliveredQty: 10,
        unitPrice: 5,
        originalPrice: null,
        priceType: "STANDARD",
        product: { name: "P1" },
        status: "PENDING",
      },
    ],
  };

  /** Same arrangement as invoices.service.spec.ts's WP-D1 deposit-mirror block. */
  function armDepositReconcile() {
    prisma.invoice.findFirst.mockResolvedValue(null); // no open DRAFT pending mirror
    prisma.order.findFirst.mockResolvedValue({ status: "PENDING" }); // order-editable gate
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv-dep",
        status: InvoiceStatus.SENT,
        deliveryBatchId: null,
        discount: 0,
        shippingFee: 0,
        depositPercent: 50,
        dueDate: new Date("2026-10-01"),
        items: [],
        payments: [{ amount: 20, status: "PAID" }],
      },
    ]);
    prisma.order.findUnique.mockResolvedValue(depositOrder);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoiceItem.deleteMany.mockResolvedValue({});
    prisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve({ id: "inv-dep", ...args.data }),
    );
    prisma.orderItem.findMany.mockResolvedValue([{ id: "li1" }]);
    prisma.orderItem.update.mockResolvedValue({});
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
  }

  it("#2242: keeps the invoice's NSF fee lines through the rebuild, adding the fee after the tax proration", async () => {
    armDepositReconcile();
    // A stamped NSF line and a legacy (NULL systemKind, prefix-only) one, plus an ordinary line.
    prisma.invoiceItem.findMany.mockResolvedValue([
      {
        id: "nsf-1",
        subtotal: 25,
        description: "NSF fee — returned check P-1",
        systemKind: "NSF_FEE",
      },
      {
        id: "nsf-legacy",
        subtotal: 10,
        description: "NSF fee — returned check P-0",
        systemKind: null,
      },
      { id: "goods-1", subtotal: 50, description: "P1", systemKind: null },
    ]);

    await service.reconcileOrderDraftInvoice("o-dep", { basis: "order" });

    // Only the order-derived lines are deleted; both NSF lines survive.
    expect(prisma.invoiceItem.deleteMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-dep", id: { notIn: ["nsf-1", "nsf-legacy"] } },
    });
    const data = prisma.invoice.update.mock.calls[0][0].data;
    // goods 50 + fees 35 = 85; the tax stays the order share on GOODS (5), not on the fee.
    expect(data.subtotal).toBeCloseTo(85, 2);
    expect(data.taxAmount).toBeCloseTo(5, 2);
    expect(data.total).toBeCloseTo(90, 2);
    expect(data.status).toBe(InvoiceStatus.PARTIAL); // 20 paid of 90
  });
});
