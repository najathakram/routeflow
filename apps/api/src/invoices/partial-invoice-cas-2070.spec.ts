/**
 * #2070 / SA-523 (tier 1): concurrent partial invoices must never over-bill an order line.
 * `createPartialFromOrder` checks `qty − invoicedQty` on a read made BEFORE its transaction and used
 * to bump `invoicedQty` unconditionally inside it, so two partials for the last 96 pieces both
 * passed and the line ended at 192. The bump is now a compare-and-set on exactly what was read
 * (`partial-invoice-cas.ts`); a miss is a 409 and the whole partial rolls back. Duplicate lines and a
 * non-positive qty are refused (400) before the transaction. The real-PG race is
 * partial-invoice-cas-2070.db.spec.ts. Red-first. Bootstrap copied from invoices.service.b652.spec.ts.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));

jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

import { assertPartialRequestShape, bumpInvoicedQtyCas } from "./partial-invoice-cas";

describe("partial invoices: the invoicedQty bump is a compare-and-set (#2070, SA-523)", () => {
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
    // #2070: createPartialFromOrder's invoicedQty bump is a CAS (updateMany); a clean read matches 1.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
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
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const line = (over: any = {}) => ({
    id: "oi-1",
    productId: "p-1",
    qty: 96,
    invoicedQty: 0,
    boxes: 96,
    pieces: 0,
    unitsPerBox: 1,
    unitPrice: 10,
    subtotal: 960,
    status: "PENDING",
    product: { name: "Widget", unitsPerBox: 1 },
    ...over,
  });
  const order = (lines: any[] = [line()]) => ({
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-1",
    subtotal: 960,
    tax: 0,
    shippingFee: 0,
    lineItems: lines,
  });

  beforeEach(() => {
    prisma.customer.findUnique.mockResolvedValue({ isTaxExempt: false } as any);
    prisma.invoice.aggregate.mockResolvedValue({ _sum: { shippingFee: 0 } });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ ...args.data, id: "inv-1", items: [], payments: [], customer: {} }),
    );
    prisma.order.findUnique.mockResolvedValue(order() as any);
  });

  describe("createPartialFromOrder", () => {
    it("bumps with a CAS on the values read: id, invoicedQty, qty, and not CANCELLED", async () => {
      prisma.order.findUnique.mockResolvedValue(order([line({ invoicedQty: 40 })]) as any);
      await service.createPartialFromOrder("ord-1", {
        items: [{ orderItemId: "oi-1", qty: 56 }],
      } as any);
      expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
        where: { id: "oi-1", invoicedQty: 40, qty: 96, status: { not: "CANCELLED" } },
        data: { invoicedQty: { increment: 56 } },
      });
      expect(prisma.orderItem.update).not.toHaveBeenCalled(); // never the unconditional bump
    });

    it("a CAS miss (the line changed since the read) ⇒ 409, and the credit settle never runs", async () => {
      mockCreditNotes.settleOrderCreditsInTx.mockClear(); // a file-scoped mock
      prisma.orderItem.updateMany.mockResolvedValue({ count: 0 } as any);
      const caught: any = await service
        .createPartialFromOrder("ord-1", { items: [{ orderItemId: "oi-1", qty: 96 }] } as any)
        .catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(mockCreditNotes.settleOrderCreditsInTx).not.toHaveBeenCalled();
    });

    it("the second line's miss fails the WHOLE partial (no half-billed invoice)", async () => {
      prisma.order.findUnique.mockResolvedValue(
        order([line(), line({ id: "oi-2", productId: "p-2" })]) as any,
      );
      prisma.orderItem.updateMany
        .mockResolvedValueOnce({ count: 1 } as any)
        .mockResolvedValueOnce({ count: 0 } as any);
      const caught: any = await service
        .createPartialFromOrder("ord-1", {
          items: [
            { orderItemId: "oi-1", qty: 10 },
            { orderItemId: "oi-2", qty: 10 },
          ],
        } as any)
        .catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1); // one tx: the rollback covers both
    });

    it("a duplicate order line in one request ⇒ 400 before the transaction", async () => {
      const caught: any = await service
        .createPartialFromOrder("ord-1", {
          items: [
            { orderItemId: "oi-1", qty: 50 },
            { orderItemId: "oi-1", qty: 50 },
          ],
        } as any)
        .catch((e) => e);
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    });

    it.each([0, -5])("qty %d ⇒ 400 before the transaction", async (qty) => {
      const caught: any = await service
        .createPartialFromOrder("ord-1", { items: [{ orderItemId: "oi-1", qty }] } as any)
        .catch((e) => e);
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });
  });

  describe("bumpInvoicedQtyCas", () => {
    it("SA-511c: a missing where-value throws BEFORE any write (never a silently dropped key)", async () => {
      const tx = { orderItem: { updateMany: jest.fn() } };
      for (const li of [{ id: "oi-1", qty: 96 }, { id: "oi-1", invoicedQty: 0 }, undefined])
        await expect(
          bumpInvoicedQtyCas(tx, [{ orderItemId: "oi-1", qty: 1 }], new Map([["oi-1", li]])),
        ).rejects.toThrow(/where-value missing/);
      expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
    });

    it("assertPartialRequestShape accepts distinct lines with positive qty", () => {
      expect(() =>
        assertPartialRequestShape([
          { orderItemId: "a", qty: 1 },
          { orderItemId: "b", qty: 0.5 },
        ]),
      ).not.toThrow();
    });
  });
});
