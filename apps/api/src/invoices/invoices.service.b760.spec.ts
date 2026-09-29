/**
 * B760 (SA-106/SA-113(ii)) — remaining-to-bill caps at the delivered basis. createInvoiceFromOrder
 * and createPartialFromOrder compute remaining as min(qty, delivered basis) - invoicedQty via
 * #1274/B667's shared deliveredBasisByLine/billableQtyFromBasis helper.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is already at its ceiling). Same bootstrap pattern
 * as invoices.service.b763.spec.ts; duplicated deliberately rather than shared, so this file
 * stays self-contained and small.
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

describe("InvoicesService — B760", () => {
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
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
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
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  // B760/SA-113(ii): remaining caps at the delivered basis, via #1274/B667's shared helper.
  describe("createPartialFromOrder / createInvoiceFromOrder — B760 delivered-basis cap", () => {
    const oiB760 = {
      id: "oi-b760",
      productId: "p-1",
      qty: 10,
      invoicedQty: 0,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 10,
      subtotal: 100,
      product: { name: "Widget", unitsPerBox: null },
    };
    const orderB760 = {
      id: "ord-b760",
      customerId: "cust-1",
      orderNumber: "ORD-B760",
      subtotal: 100,
      tax: 0,
      shippingFee: 0,
      lineItems: [oiB760],
    };

    beforeEach(() => {
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false } as any);
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
      );
      prisma.orderItem.update.mockResolvedValue({} as any);
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.order.findUnique.mockResolvedValue(orderB760);
      // #2632: bumpInvoicedQtyCas needs its updateMany to report the one row it bumped.
      prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    });

    const partial6of10 = [{ orderItemId: "oi-b760", type: "PARTIAL", quantityDelivered: 6 }];

    it("createPartialFromOrder caps at a short-delivered line's basis: refuses beyond it, allows exactly it (ordered 10, delivered 6)", async () => {
      prisma.deliveryMutation.findMany.mockResolvedValue(partial6of10);
      await expect(
        service.createPartialFromOrder("ord-b760", {
          items: [{ orderItemId: "oi-b760", qty: 10 }],
        } as any),
      ).rejects.toThrow(/exceeds remaining 6 for .*\(delivered 6\)/);
      const invoice = (await service.createPartialFromOrder("ord-b760", {
        items: [{ orderItemId: "oi-b760", qty: 6 }],
      } as any)) as any;
      expect(Number(invoice.subtotal)).toBe(60);
    });

    it("createInvoiceFromOrder bills only the delivered basis, not the full ordered qty", async () => {
      prisma.deliveryMutation.findMany.mockResolvedValue(partial6of10);
      await service.createInvoiceFromOrder("ord-b760");
      const createdLines = prisma.invoice.create.mock.calls[0][0].data.items.create;
      expect(createdLines).toHaveLength(1);
      expect(Number(createdLines[0].qty)).toBe(6);
    });

    it("no DeliveryMutation rows at all keeps the OLD qty - invoicedQty behaviour, unconstrained", async () => {
      prisma.deliveryMutation.findMany.mockResolvedValue([]);
      const invoice = (await service.createPartialFromOrder("ord-b760", {
        items: [{ orderItemId: "oi-b760", qty: 10 }],
      } as any)) as any;
      expect(Number(invoice.subtotal)).toBe(100);
    });

    // Writer-shaped: completeStop stamps quantityDelivered in the line's own qty unit — pieces for
    // a boxed line (routes.service.ts deliveryMutation.create, RunDeliveryDto.quantityDelivered).
    const withLine = (patch: Record<string, unknown>) =>
      prisma.order.findUnique.mockResolvedValue({
        ...orderB760,
        lineItems: [{ ...oiB760, ...patch }],
      });
    const delivered = (qty: number) => [
      { orderItemId: "oi-b760", type: "PARTIAL", quantityDelivered: qty },
    ];
    const casePieces = {
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: 1,
      subtotal: 24,
      product: { name: "Widget", unitsPerBox: 12 },
    };

    it("a line counted in pieces (24 pcs, 12/box, 12 delivered) bills 12 and refuses 24", async () => {
      withLine(casePieces);
      prisma.deliveryMutation.findMany.mockResolvedValue(delivered(12));
      await expect(
        service.createPartialFromOrder("ord-b760", {
          items: [{ orderItemId: "oi-b760", qty: 24 }],
        } as any),
      ).rejects.toThrow(/exceeds remaining 12 /);
      await service.createInvoiceFromOrder("ord-b760");
      const createdLines = prisma.invoice.create.mock.calls[0][0].data.items.create;
      expect(createdLines).toHaveLength(1);
      expect(Number(createdLines[0].qty)).toBe(12);
    });

    it("an already-invoiced line under the cap bills only delivered - invoiced (10 ordered, 6 delivered, 4 invoiced)", async () => {
      withLine({ invoicedQty: 4 });
      prisma.deliveryMutation.findMany.mockResolvedValue(delivered(6));
      await expect(
        service.createPartialFromOrder("ord-b760", {
          items: [{ orderItemId: "oi-b760", qty: 3 }],
        } as any),
      ).rejects.toThrow(/exceeds remaining 2 /);
      await service.createInvoiceFromOrder("ord-b760");
      const createdLines = prisma.invoice.create.mock.calls[0][0].data.items.create;
      expect(Number(createdLines[0].qty)).toBe(2);
    });

    it("invoiced past the delivered basis (8 invoiced, 6 delivered) reports remaining 0, never a negative", async () => {
      withLine({ invoicedQty: 8 });
      prisma.deliveryMutation.findMany.mockResolvedValue(delivered(6));
      await expect(
        service.createPartialFromOrder("ord-b760", {
          items: [{ orderItemId: "oi-b760", qty: 1 }],
        } as any),
      ).rejects.toThrow(/exceeds remaining 0 /);
    });
  });
});
