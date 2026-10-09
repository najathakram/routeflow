/**
 * B1043 (SA-742r2 INV-A) — the header-only PATCH (a discount or shippingFee with NO `items`) recomputed
 * the invoice tax as `round(Σ line subtotal × rate)`: no regulated category tax (a levy line lost its levy),
 * no tax-exempt check (an exempt customer got taxed) and a read OUTSIDE any transaction or lock (B1045).
 *
 * The rule now (F1, "lines unchanged => tax unchanged"): lock the order + invoice, read the stored lines in
 * the tx, run the ONE builder (`sumInvoiceTotals`) over them. If its subtotal or tax differs from the invoice's
 * stored subtotal / taxAmount the header cannot be trusted and the PATCH is refused with 409
 * INVOICE_TAX_STATE_STALE ("re-save the invoice lines"), nothing written. Otherwise only discount, shippingFee
 * and total are written. A dedicated file: invoices.service.spec.ts sits at its size-ratchet ceiling.
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

describe("InvoicesService.update() — B1043 the header-only PATCH on the one builder", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // units_v1 guard reads the parent invoice
    // The tx the service runs in: the same model mocks, plus a per-test raw query (the NULL-tenant line count).
    queryRaw = jest.fn().mockResolvedValue([]);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0), $queryRaw: queryRaw }),
    );

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

    service = module.get<InvoicesService>(InvoicesService);
  });

  const draft = {
    id: "inv-1",
    orderId: null as string | null,
    tenantId: "test-tenant",
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-0099",
    status: InvoiceStatus.DRAFT,
    subtotal: 100,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 100,
    notes: null,
    terms: null,
    dueDate: null,
    issueDate: new Date(),
  };
  const row = (o: Record<string, unknown> = {}) => ({
    id: "item-1",
    description: "Widget",
    qty: 1,
    unitPrice: 100,
    discount: 0,
    subtotal: 100,
    taxRate: 0,
    categoryTaxAmount: 0,
    ...o,
  });

  /** Stored invoice + its lines, as the locked tx reads them. */
  const arrange = (
    invoice: Record<string, unknown>,
    lines: Record<string, unknown>[],
    opts: { exempt?: boolean; payments?: Record<string, unknown>[] } = {},
  ) => {
    prisma.invoice.findUnique.mockResolvedValue({ ...draft, ...invoice });
    prisma.invoiceItem.findMany.mockResolvedValue(lines);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: !!opts.exempt });
    prisma.invoicePayment.findMany.mockResolvedValue(opts.payments ?? []);
    prisma.invoice.update.mockResolvedValue({ ...draft, ...invoice });
    prisma.order.findFirst.mockResolvedValue({ lineItems: [] }); // units_v1 guard reads the linked order
  };
  const written = () => prisma.invoice.update.mock.calls[0][0].data;
  const nothingWritten = () => expect(prisma.invoice.update).not.toHaveBeenCalled();

  describe("F1 rows (lines unchanged => tax unchanged)", () => {
    it("a regulated line (levy 5.00, non-exempt, consistent): shippingFee 10 keeps the tax, total +10", async () => {
      arrange({ subtotal: 100, taxAmount: 5, total: 105 }, [row({ categoryTaxAmount: 5 })]);
      await service.update("inv-1", { shippingFee: 10 });
      expect(written().total).toBe(115);
      expect(written()).not.toHaveProperty("taxAmount");
    });

    it("an exempt customer (stored rate 0.08, stored tax 0): shippingFee 1 -> tax 0, total +1, no 409", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row({ taxRate: 0.08 })], {
        exempt: true,
      });
      await service.update("inv-1", { shippingFee: 1 });
      expect(written().total).toBe(101);
    });

    it("an exempt customer with a stored levy 5.00: 409 INVOICE_TAX_STATE_STALE, nothing written", async () => {
      arrange({ subtotal: 100, taxAmount: 5, total: 105 }, [row({ categoryTaxAmount: 5 })], {
        exempt: true,
      });
      const run = service.update("inv-1", { shippingFee: 1 });
      await expect(run).rejects.toMatchObject({
        status: 409,
        response: { code: "INVOICE_TAX_STATE_STALE" },
      });
      await expect(run).rejects.toThrow(/re-save the invoice lines/i);
      nothingWritten();
    });

    it("a legacy row (rate 0, stored tax 4.00): discount 1 -> 409, nothing written", async () => {
      arrange({ subtotal: 100, taxAmount: 4, total: 104 }, [row({ taxRate: 0 })]);
      await expect(service.update("inv-1", { discount: 1 })).rejects.toMatchObject({
        status: 409,
        response: { code: "INVOICE_TAX_STATE_STALE" },
      });
      nothingWritten();
    });

    it("a stored subtotal that is not the lines' sum -> 409, nothing written", async () => {
      arrange({ subtotal: 90, taxAmount: 0, total: 90 }, [row()]);
      await expect(service.update("inv-1", { discount: 1 })).rejects.toMatchObject({ status: 409 });
      nothingWritten();
    });

    it("non-exempt, levy 5: discount 2 -> subtotal and tax identical, total -2", async () => {
      arrange({ subtotal: 100, taxAmount: 5, total: 105 }, [row({ categoryTaxAmount: 5 })]);
      await service.update("inv-1", { discount: 2 });
      expect(written()).toMatchObject({ discount: 2, total: 103 });
      expect(written()).not.toHaveProperty("subtotal");
    });

    it("mixed taxable / non-taxable, non-exempt, consistent: characterization (unchanged behaviour)", async () => {
      arrange({ subtotal: 150, taxAmount: 8, total: 158 }, [
        row({ taxRate: 0.08 }),
        row({ id: "item-2", subtotal: 50, unitPrice: 50, taxRate: 0 }),
      ]);
      await service.update("inv-1", { discount: 3 });
      expect(written().total).toBe(155);
    });
  });

  describe("one transaction, one locked read (F4 / B1045)", () => {
    it("reads and writes inside the tenant transaction, and the header fields + totals go in ONE update", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()]);
      await service.update("inv-1", { discount: 5, notes: "hello" });
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
      expect(written()).toMatchObject({ notes: "hello", discount: 5, total: 95 });
    });

    it("a notes-only PATCH touches no totals (no transaction needed)", async () => {
      arrange({}, [row()]);
      await service.update("inv-1", { notes: "just a note" });
      expect(written()).toEqual({ notes: "just a note" });
    });

    it("r87: an invoice that left DRAFT between the first read and the lock is refused", async () => {
      prisma.invoice.findUnique
        .mockResolvedValueOnce({ ...draft }) // findOneOrThrow, unlocked
        .mockResolvedValue({ ...draft, status: InvoiceStatus.SENT }); // under the lock
      prisma.invoiceItem.findMany.mockResolvedValue([row()]);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      await expect(service.update("inv-1", { discount: 1 })).rejects.toMatchObject({ status: 400 });
      nothingWritten();
    });

    it("r87: the items rewrite refuses an invoice that left DRAFT under the lock too", async () => {
      prisma.invoice.findUnique
        .mockResolvedValueOnce({ ...draft })
        .mockResolvedValue({ ...draft, status: InvoiceStatus.SENT });
      prisma.invoiceItem.findMany.mockResolvedValue([row()]);
      prisma.product.findMany.mockResolvedValue([]);
      prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
      await expect(
        service.update("inv-1", { items: [{ description: "Widget", qty: 1, unitPrice: 100 }] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
      nothingWritten();
    });

    it("a stored line with a NULL or foreign tenant fails closed (400) instead of being dropped", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()]);
      queryRaw.mockResolvedValue([{ n: 1 }]);
      await expect(service.update("inv-1", { discount: 1 })).rejects.toMatchObject({ status: 400 });
      nothingWritten();
    });
  });

  describe("side effects (parity with the items branch)", () => {
    it("recomputes the linked order once, and never touches the regulated ledger for unchanged lines", async () => {
      arrange({ orderId: "ord-1", subtotal: 100, taxAmount: 0, total: 100 }, [row()]);
      jest.spyOn(service as any, "assertOrderInvoiceUnlocked").mockResolvedValue(undefined);
      const recompute = jest
        .spyOn(service as any, "recomputeOrderFromInvoices")
        .mockResolvedValue(undefined);
      const resync = jest.spyOn(service as any, "resyncInvoiceLedger").mockResolvedValue(undefined);
      await service.update("inv-1", { shippingFee: 4 });
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(recompute).toHaveBeenCalledWith("ord-1");
      expect(resync).not.toHaveBeenCalled();
    });

    it("a refused PATCH recomputes nothing", async () => {
      arrange({ orderId: "ord-1", subtotal: 100, taxAmount: 4, total: 104 }, [row()]);
      jest.spyOn(service as any, "assertOrderInvoiceUnlocked").mockResolvedValue(undefined);
      const recompute = jest
        .spyOn(service as any, "recomputeOrderFromInvoices")
        .mockResolvedValue(undefined);
      await expect(service.update("inv-1", { discount: 1 })).rejects.toBeDefined();
      expect(recompute).not.toHaveBeenCalled();
    });
  });

  describe("B1046 - a DRAFT with applied credit cannot be discounted below what is already paid", () => {
    const paid = [{ id: "p1", amount: 50, status: "PAID" }];

    it("discount 70 on a $100 invoice with $50 of confirmed credit -> 409, nothing written", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()], { payments: paid });
      await expect(service.update("inv-1", { discount: 70 })).rejects.toMatchObject({
        status: 409,
        response: { code: "INVOICE_TOTAL_BELOW_PAID" },
      });
      nothingWritten();
    });

    it("control: a discount that leaves the total at the paid amount saves (paid == total is not an overpayment)", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()], { payments: paid });
      await service.update("inv-1", { discount: 50 });
      expect(written().total).toBe(50);
    });

    it("not worse: an invoice ALREADY overpaid may still be saved when the edit does not deepen it", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 40, discount: 60 }, [row()], {
        payments: paid,
      });
      await service.update("inv-1", { shippingFee: 5 });
      expect(written().total).toBe(45);
    });

    it("an unconfirmed (pending) payment is not paid money", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()], {
        payments: [{ id: "p2", amount: 90, status: "PENDING" }],
      });
      await service.update("inv-1", { discount: 70 });
      expect(written().total).toBe(30);
    });

    it("the items rewrite is held to the same rule: lines edited down below the credit are refused", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row({ id: "item-1" })], {
        payments: paid,
      });
      await expect(
        service.update("inv-1", {
          items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 20 }],
        }),
      ).rejects.toMatchObject({ status: 409, response: { code: "INVOICE_TOTAL_BELOW_PAID" } });
      nothingWritten();
    });
  });

  describe("B1047 - discount and shipping are rounded to cents at intake", () => {
    it("header-only: discount 10.005 stores 10.01 and the total follows the stored cents", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()]);
      await service.update("inv-1", { discount: 10.005 });
      expect(written().discount).toBe(10.01);
      expect(written().total).toBe(89.99);
    });

    it("header-only: shippingFee 2.004 stores 2.00", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()]);
      await service.update("inv-1", { shippingFee: 2.004 });
      expect(written().shippingFee).toBe(2);
      expect(written().total).toBe(102);
    });

    it("items rewrite: discount 10.005 stores 10.01 (the same intake)", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row({ id: "item-1" })]);
      await service.update("inv-1", {
        items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 100 }],
        discount: 10.005,
      });
      expect(written().discount).toBe(10.01);
      expect(written().total).toBe(89.99);
    });

    it("create(): discount 10.005 stores 10.01 and the total follows", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", isTaxExempt: false });
      prisma.invoice.create.mockImplementation((args: any) =>
        Promise.resolve({ ...args.data, id: "inv-new", items: [], payments: [], customer: {} }),
      );
      await service.create({
        customerId: "cust-1",
        items: [{ description: "Widget", qty: 1, unitPrice: 100 }],
        discount: 10.005,
      } as any);
      const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
      expect(Number(data.discount)).toBe(10.01);
      expect(Number(data.total)).toBe(89.99);
    });

    it('a NEGATIVE stored subtotal is refused as such, not as "discount cannot exceed subtotal (-35)"', async () => {
      arrange({ subtotal: -35, taxAmount: 0, total: -35 }, [
        row({ subtotal: -35, unitPrice: 5, discount: 40 }),
      ]);
      const err: any = await service.update("inv-1", { discount: 1 }).catch((e) => e);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/subtotal cannot be negative/i);
    });
  });
});
