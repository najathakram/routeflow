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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

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
          useValue: { autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }) },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241
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

  /** preservedNsfLines reads the invoice's own lines per invoice id; one NSF line per id given. */
  function armNsfLines(byInvoice: Record<string, Array<{ id: string; kind: string | null }>>) {
    prisma.invoiceItem.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        (byInvoice[args?.where?.invoiceId] ?? []).map((n) => ({
          id: n.id,
          subtotal: 25,
          description: "NSF fee — returned check P-9",
          systemKind: n.kind,
        })),
      ),
    );
  }

  it.each([
    ["a stamped", "NSF_FEE"],
    ["a legacy prefix-only", null],
  ])(
    "#2387 fold: the delivered reconcile of a SENT deposit mirror (rebuildSiblingDrafts) keeps %s NSF line",
    async (_n, kind) => {
      // Ordered 2 × $25 (tax $5), delivered 1. $10 confirmed + a $20 bounced (VOID) check.
      prisma.invoice.findFirst.mockImplementation((args: any) =>
        Promise.resolve(args?.where?.status === InvoiceStatus.DRAFT ? null : { id: "inv-dep" }),
      );
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-dep",
          status: InvoiceStatus.SENT,
          deliveryBatchId: null,
          depositPercent: 50,
          discount: 0,
          shippingFee: 0,
          dueDate: new Date("2026-10-01"),
          items: [],
          payments: [
            { amount: 10, status: "PAID" },
            { amount: 20, status: "VOID" },
          ],
        },
      ]);
      prisma.order.findUnique.mockResolvedValue({
        id: "o-dep",
        customerId: "c1",
        subtotal: 50,
        tax: 5,
        shippingFee: 0,
        lineItems: [
          {
            id: "li1",
            productId: "p1",
            qty: 2,
            deliveredQty: 1,
            unitPrice: 25,
            originalPrice: null,
            priceType: "STANDARD",
            product: { name: "P1" },
            status: "DELIVERED",
          },
        ],
      });
      prisma.deliveryMutation.findMany.mockResolvedValue([]);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      prisma.invoiceItem.deleteMany.mockResolvedValue({});
      prisma.invoice.update.mockImplementation((args: any) =>
        Promise.resolve({ id: args.where.id, ...args.data, items: [] }),
      );
      prisma.orderItem.update.mockResolvedValue({});
      armNsfLines({ "inv-dep": [{ id: "nsf-1", kind }] });

      await service.reconcileDeliveredOrdersInTx(prisma, ["o-dep"]);

      expect(prisma.invoiceItem.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: "inv-dep", id: { notIn: ["nsf-1"] } },
      });
      const data = prisma.invoice.update.mock.calls[0][0].data;
      expect(data.items.create).toHaveLength(1); // only the delivered goods line is re-created
      expect(data.subtotal).toBeCloseTo(50, 2); // delivered goods 25 + fee 25
      expect(data.taxAmount).toBeCloseTo(2.5, 2); // the order's tax share on GOODS only
      expect(data.total).toBeCloseTo(52.5, 2);
      expect(data.status).toBe(InvoiceStatus.PARTIAL); // $10 confirmed of 52.50
    },
  );

  it("#2387 fold: split siblings keep their NSF line; the tax remainder and shipping stay on -R1", async () => {
    // Standard line $10 (base) + a SEPARATE_INVOICE line 3 × $10 (-R1); order tax 0.50, ship 5.
    // The NSF fee sits on the BASE draft: were it counted before the proration and fee
    // placement, the base (10 + 25) would outweigh -R1 (30) and take the remainder and shipping.
    const draft = (id: string, cat: string | null) => ({
      id,
      status: InvoiceStatus.DRAFT,
      deliveryBatchId: null,
      discount: 0,
      shippingFee: 0,
      items: [{ orderItemId: cat ? "li-r" : "li-s", trackedCategoryId: cat, unitsPerBox: null }],
    });
    prisma.invoice.findMany.mockResolvedValue([draft("inv-base", null), draft("inv-r1", "cat-r")]);
    const line = (id: string, qty: number, cat: string | null) => ({
      id,
      productId: `p-${id}`,
      qty,
      deliveredQty: 0,
      unitPrice: 10,
      originalPrice: null,
      priceType: "STANDARD",
      trackedCategoryId: cat,
      product: { name: id, trackedCategoryId: cat },
      status: "PENDING",
    });
    prisma.order.findUnique.mockResolvedValue({
      id: "o-split",
      customerId: "c1",
      subtotal: 40,
      tax: 0.5,
      shippingFee: 5,
      lineItems: [line("li-s", 1, null), line("li-r", 3, "cat-r")],
    });
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-r", name: "R", invoiceTreatment: "SEPARATE_INVOICE", taxType: "NONE", rate: 0 },
    ]);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoiceItem.deleteMany.mockResolvedValue({});
    prisma.invoice.update.mockImplementation((args: any) =>
      Promise.resolve({ id: args.where.id, ...args.data, items: [] }),
    );
    prisma.orderItem.update.mockResolvedValue({});
    armNsfLines({ "inv-base": [{ id: "nsf-base", kind: "NSF_FEE" }] });

    await service.reconcileOrderDraftInvoice("o-split", { basis: "order" });

    const byId = Object.fromEntries(
      prisma.invoice.update.mock.calls.map((c: any) => [c[0].where.id, c[0].data]),
    );
    expect(prisma.invoiceItem.deleteMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-base", id: { notIn: ["nsf-base"] } },
    });
    // base: goods 10 + fee 25; tax round(0.125) = 0.13; no shipping.
    expect(byId["inv-base"].subtotal).toBeCloseTo(35, 2);
    expect(byId["inv-base"].taxAmount).toBeCloseTo(0.13, 2);
    expect(byId["inv-base"].shippingFee).toBe(0);
    expect(byId["inv-base"].total).toBeCloseTo(35.13, 2);
    // -R1 (the larger GOODS subtotal): round(0.375) = 0.38 less the -0.01 remainder = 0.37, + ship 5.
    expect(byId["inv-r1"].subtotal).toBeCloseTo(30, 2);
    expect(byId["inv-r1"].taxAmount).toBeCloseTo(0.37, 2);
    expect(byId["inv-r1"].shippingFee).toBe(5);
    expect(byId["inv-r1"].total).toBeCloseTo(35.37, 2);
  });
});
