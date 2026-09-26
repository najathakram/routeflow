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
 * B294 (REG-B294, SA-141) — adjusting a LEGACY order-derived invoice (every line taxRate 0, a real
 * header tax) keeps its sales tax: the inferred flat rate is stamped onto its lines, and the
 * recompute reproduces the tax. Its own file: invoices.service.spec.ts is at its ratchet ceiling.
 *
 * The invoice's lines live in memory below, so the stamp and the recompute are real, not echoed.
 */
describe("B294 — applyPriceAdjustment keeps a legacy invoice's sales tax (REG-B294)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let rows: Array<Record<string, any>>;

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

  /** One invoice whose lines are held in memory; update/updateMany/findMany act on them. */
  const withInvoice = (header: Record<string, any>, lines: Array<Record<string, any>>) => {
    rows = lines.map((l) => ({ ...l }));
    const invoice = {
      id: "inv-1",
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
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoiceItem.update.mockImplementation(async ({ where, data }: any) =>
      Object.assign(
        rows.find((r) => r.id === where.id)!,
        data,
      ),
    );
    prisma.invoiceItem.updateMany.mockImplementation(async ({ where, data }: any) => {
      const hit = rows.filter((r) => Number(r.taxRate) === Number(where.taxRate));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    });
    prisma.invoiceItem.findMany.mockImplementation(async () => rows.map((r) => ({ ...r })));
  };
  const line = (id: string, subtotal: number, taxRate: number) => ({
    id,
    productId: `p-${id}`,
    qty: 1,
    unitPrice: subtotal,
    subtotal,
    discount: 0,
    taxRate,
    categoryTaxAmount: 0,
  });
  const invoiceWrite = () => prisma.invoice.update.mock.calls[0][0].data;

  it("REG-B294: $100 at 7.5% (lines stored at 0) adjusted to $95 → tax $7.13, total $102.13", async () => {
    withInvoice({ subtotal: 100, taxAmount: 7.5, total: 107.5 }, [line("li-1", 100, 0)]);

    await service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "li-1", newUnitPrice: 95 }],
      scope: "SINGLE",
    });

    expect(prisma.invoiceItem.updateMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-1", taxRate: 0 },
      data: { taxRate: 0.075 },
    });
    expect(invoiceWrite()).toMatchObject({ subtotal: 95, taxAmount: 7.13, total: 102.13 });
  });

  it("PIN-B294-mixed: one line at 7.5% and one at 0 is NOT inferred — nothing is stamped", async () => {
    withInvoice({ subtotal: 100, taxAmount: 3.75, total: 103.75 }, [
      line("li-1", 50, 0.075),
      line("li-2", 50, 0),
    ]);

    await service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "li-1", newUnitPrice: 40 }],
      scope: "SINGLE",
    });

    expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
    // Only the rated line carries tax: 40 × 7.5% = 3.00.
    expect(invoiceWrite()).toMatchObject({ subtotal: 90, taxAmount: 3, total: 93 });
  });

  it("PIN-B294-untaxed: an invoice with no tax stays untaxed", async () => {
    withInvoice({ subtotal: 100, taxAmount: 0, total: 100 }, [line("li-1", 100, 0)]);

    await service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "li-1", newUnitPrice: 95 }],
      scope: "SINGLE",
    });

    expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(invoiceWrite()).toMatchObject({ subtotal: 95, taxAmount: 0, total: 95 });
  });
});
