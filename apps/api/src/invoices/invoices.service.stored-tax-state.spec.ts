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
import { InvoiceStatus } from "@prisma/client";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { isNsfLine } from "./nsf-line";

/**
 * SA-814 R5-2 — an invoice recompute never re-taxes lines whose stored rates cannot reproduce the stored
 * tax. Three paths re-derive tax from rows already stored: the price adjustment, the DRAFT items edit and
 * the header-only discount / shipping PATCH. Before the guard only the header-only path refused; the other
 * two wrote regular tax $0 for a legacy invoice (every line at rate 0, a real header tax) when the B294
 * inferred flat rate did not verify.
 *
 * The invoice's lines live in memory below, so the stamp and the recompute are real, not echoed.
 *
 * UNVERIFIABLE: $10,000.00 at 8.875%. The header tax is $887.50 but the inferred rate rounds to the column's
 * four places (0.0888), and 10000 x 0.0888 = 888.00 != 887.50, so no rate can be stamped.
 * VERIFIED: $100.00 at 7.5% (the REG-B294 pin in invoices.service.b294-adjust.spec.ts: -> $95 = $102.13).
 */
describe("SA-814 R5-2 — one recompute guard for stored tax state", () => {
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

  /** One invoice whose lines are held in memory; update/updateMany/findMany act on them. */
  const withInvoice = (header: Record<string, any>, lines: Array<Record<string, any>>) => {
    rows = lines.map((l) => ({ ...l }));
    const invoice = {
      id: "inv-1",
      orderId: null,
      customerId: "cust-1",
      status: InvoiceStatus.SENT,
      discount: 0,
      shippingFee: 0,
      dueDate: null,
      payments: [],
      ...header,
      items: rows.map((r) => ({ ...r })),
    };
    prisma.invoice.findUnique.mockResolvedValue(invoice);
    prisma.invoice.update.mockResolvedValue({ id: "inv-1", items: [] });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoiceItem.update.mockImplementation(async ({ where, data }: any) =>
      Object.assign(
        rows.find((r) => r.id === where.id),
        data,
      ),
    );
    prisma.invoiceItem.updateMany.mockImplementation(async ({ where, data }: any) => {
      const hit = rows.filter(
        (r) => Number(r.taxRate) === Number(where.taxRate) && (!where.AND || !isNsfLine(r)),
      );
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    });
    prisma.invoiceItem.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
  };
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
  const payloadLine = (id: string, unitPrice: number, taxRate: number) => ({
    id,
    description: "Widget",
    qty: 1,
    unitPrice,
    taxRate,
  });
  const UNVERIFIABLE = { subtotal: 10000, taxAmount: 887.5, total: 10887.5 };
  const VERIFIED = { subtotal: 100, taxAmount: 7.5, total: 107.5 };
  const invoiceWrite = () => prisma.invoice.update.mock.calls[0][0].data;
  const nothingWritten = () => {
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
  };
  const STALE = { status: 409, response: { code: "INVOICE_TAX_STATE_STALE" } };

  describe("price adjustment", () => {
    it("(a) a legacy all-zero-rate invoice whose rate does NOT verify is 409 INVOICE_TAX_STATE_STALE and its tax is unchanged", async () => {
      withInvoice(UNVERIFIABLE, [line("li-1", 10000, 0)]);

      // Master: resolves, writes taxAmount 0 and total 9000 ($887.50 of tax silently dropped).
      await expect(
        service.applyPriceAdjustment("inv-1", {
          items: [{ itemId: "li-1", newUnitPrice: 9000 }],
          scope: "SINGLE",
        }),
      ).rejects.toMatchObject(STALE);
      nothingWritten();
      expect(rows[0]).toMatchObject({ unitPrice: 10000, subtotal: 10000, taxRate: 0 });
    });

    it("(c) a VERIFIED legacy invoice still adjusts with its tax kept: $100 at 7.5% -> $95 = $102.13 (the REG-B294 pin)", async () => {
      withInvoice(VERIFIED, [line("li-1", 100, 0)]);

      await service.applyPriceAdjustment("inv-1", {
        items: [{ itemId: "li-1", newUnitPrice: 95 }],
        scope: "SINGLE",
      });

      expect(rows[0].taxRate).toBe(0.075);
      expect(invoiceWrite()).toMatchObject({ subtotal: 95, taxAmount: 7.13, total: 102.13 });
    });

    it("(d) control: an invoice created at a rate the column stores exactly adjusts with no drift and no stamp", async () => {
      withInvoice(VERIFIED, [line("li-1", 100, 0.075)]);

      await service.applyPriceAdjustment("inv-1", {
        items: [{ itemId: "li-1", newUnitPrice: 95 }],
        scope: "SINGLE",
      });

      expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
      expect(invoiceWrite()).toMatchObject({ subtotal: 95, taxAmount: 7.13, total: 102.13 });
    });
  });

  describe("DRAFT items edit (a web re-save re-sends the stored rate, 0 for a legacy row)", () => {
    const draft = { status: InvoiceStatus.DRAFT };

    it("(b) re-saving the unverifiable legacy invoice with a changed price is 409 INVOICE_TAX_STATE_STALE and writes nothing", async () => {
      withInvoice({ ...draft, ...UNVERIFIABLE }, [line("li-1", 10000, 0)]);

      // Master: resolves, writes taxAmount 0 and total 9000.
      await expect(
        service.update("inv-1", { items: [payloadLine("li-1", 9000, 0)] }),
      ).rejects.toMatchObject(STALE);
      nothingWritten();
    });

    it("(b2) a re-save that changes nothing but a note is refused the same way (the recompute still runs)", async () => {
      withInvoice({ ...draft, ...UNVERIFIABLE }, [line("li-1", 10000, 0)]);

      await expect(
        service.update("inv-1", { items: [payloadLine("li-1", 10000, 0)], notes: "n" }),
      ).rejects.toMatchObject(STALE);
      nothingWritten();
    });

    it("(f) a deliberate rate change on a kept line is NOT a silent drop: the user's 8.88% is taxed", async () => {
      withInvoice({ ...draft, ...UNVERIFIABLE }, [line("li-1", 10000, 0)]);

      await service.update("inv-1", { items: [payloadLine("li-1", 10000, 0.0888)] });

      expect(invoiceWrite()).toMatchObject({ subtotal: 10000, taxAmount: 888, total: 10888 });
    });

    it("(g) every stored line replaced by new ones is a full rewrite, not a re-tax of the stored lines", async () => {
      withInvoice({ ...draft, ...UNVERIFIABLE }, [line("li-1", 10000, 0)]);

      await service.update("inv-1", {
        items: [{ description: "New", qty: 1, unitPrice: 50, taxRate: 0.0888 }],
      });

      expect(invoiceWrite()).toMatchObject({ subtotal: 50, taxAmount: 4.44, total: 54.44 });
    });

    it("(c2) a VERIFIED legacy draft re-saved with a changed price keeps its tax: the inferred rate is stamped, $100 at 7.5% -> $95 = $102.13", async () => {
      withInvoice({ ...draft, ...VERIFIED }, [line("li-1", 100, 0)]);

      // Master: resolves with taxAmount 0, total 95.
      await service.update("inv-1", { items: [payloadLine("li-1", 95, 0)] });

      expect(invoiceWrite()).toMatchObject({ subtotal: 95, taxAmount: 7.13, total: 102.13 });
      expect(prisma.invoiceItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({ taxRate: 0.075 }),
        }),
      );
    });

    it("(c3) the untouched sibling of an edited line is stamped too, so the saved lines reproduce the tax", async () => {
      withInvoice({ ...draft, ...VERIFIED }, [line("li-1", 60, 0), line("li-2", 40, 0)]);

      await service.update("inv-1", {
        items: [payloadLine("li-1", 55, 0), payloadLine("li-2", 40, 0)],
      });

      expect(invoiceWrite()).toMatchObject({ subtotal: 95, taxAmount: 7.13, total: 102.13 });
      expect(prisma.invoiceItem.update).toHaveBeenCalledWith({
        where: { id: "li-2" },
        data: { taxRate: 0.075 },
      });
    });

    it("(d2) control: a draft stored at a rate the column keeps exactly re-saves with no drift", async () => {
      withInvoice({ ...draft, ...VERIFIED }, [line("li-1", 100, 0.075)]);

      await service.update("inv-1", { items: [payloadLine("li-1", 95, 0.075)] });

      expect(invoiceWrite()).toMatchObject({ subtotal: 95, taxAmount: 7.13, total: 102.13 });
    });
  });

  describe("header-only discount / shipping PATCH", () => {
    it("(e) a legacy all-zero-rate draft is still 409 INVOICE_TAX_STATE_STALE and writes nothing (behaviour unchanged)", async () => {
      withInvoice({ status: InvoiceStatus.DRAFT, ...VERIFIED }, [line("li-1", 100, 0)]);

      await expect(service.update("inv-1", { discount: 5 })).rejects.toMatchObject(STALE);
      nothingWritten();
    });

    it("(e2) control: a consistent draft prices the discount from its stored tax", async () => {
      withInvoice({ status: InvoiceStatus.DRAFT, ...VERIFIED }, [line("li-1", 100, 0.075)]);

      await service.update("inv-1", { discount: 5 });

      expect(invoiceWrite()).toMatchObject({ discount: 5, total: 102.5 });
    });
  });
});
