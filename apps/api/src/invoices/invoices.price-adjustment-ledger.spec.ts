/**
 * B662 — a price adjustment must leave the regulated ledger equal to the invoice, and the ledger write must
 * commit or fail WITH the invoice write (Senior Architect ruling 2026-09-21): one transaction, one mechanism
 * per document state. A DRAFT re-syncs exactly like `update()`; an ISSUED invoice gets an append-only
 * correction row. Pins the wiring in `applyPriceAdjustment`; the row maths is pinned in
 * regulated-ledger.service.spec.ts and the end-to-end sums in regulated-ledger-price-correction.db.spec.ts.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({ loadMsrpMap: jest.fn().mockResolvedValue(new Map()) }));

import { Test } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

const regulated = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  invoiceId: "inv-1",
  productId: `p-${id}`,
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  unitPrice: 10,
  discount: 0,
  subtotal: 100,
  qty: 10,
  taxRate: 0,
  categoryTaxAmount: 7, // stale: 7% of the OLD $100
  boxes: null,
  unitsPerBox: null,
  promoFreeUnits: null,
  orderItemId: null,
  ...over,
});
const ordinary = (id: string) => ({
  ...regulated(id),
  trackedCategoryId: null,
  categoryTaxAmount: 0,
});

describe("InvoicesService.applyPriceAdjustment — regulated ledger sync (B662)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: Record<string, jest.Mock>;
  let commission: Record<string, jest.Mock>;

  /** Arrange an invoice + what the item loop persists (unit price 5, subtotal 50, 7% levy = $3.50). */
  const arrange = (status: InvoiceStatus, items: any[]) => {
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      customerId: "cust-1",
      orderId: null,
      status,
      discount: 0,
      shippingFee: 0,
      internalNotes: null,
      payments: [],
      items,
    });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: 0.07, priceIncludesTax: false },
    ]);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.invoiceItem.update.mockResolvedValue({});
    prisma.invoice.update.mockResolvedValue({});
    prisma.invoiceItem.findMany.mockResolvedValue(
      items.map((li) => ({
        ...li,
        unitPrice: 5,
        subtotal: 50,
        categoryTaxAmount: li.trackedCategoryId ? 3.5 : 0,
      })),
    );
  };
  const adjust = (itemIds: string[]) =>
    service.applyPriceAdjustment("inv-1", {
      items: itemIds.map((itemId) => ({ itemId, newUnitPrice: 5 })),
      scope: "SINGLE",
    });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    ledger = (service as any).ledger;
    commission = (service as any).commissionEngine;
  });

  it("ISSUED: books a correction for the re-priced regulated line only (not the ordinary one)", async () => {
    arrange(InvoiceStatus.SENT, [regulated("li-1"), ordinary("li-2")]);
    await adjust(["li-1", "li-2"]);
    expect(ledger.correctSaleForPriceChange).toHaveBeenCalledTimes(1);
    expect(ledger.correctSaleForPriceChange).toHaveBeenCalledWith({
      invoiceId: "inv-1",
      lines: [
        expect.objectContaining({ invoiceItemId: "li-1", qty: 10, netSales: 50, categoryTax: 3.5 }),
      ],
      db: expect.anything(),
    });
    // one mechanism per state: an issued invoice never re-syncs
    expect(ledger.reverseInvoiceEntries).not.toHaveBeenCalled();
    expect(ledger.writeSaleEntries).not.toHaveBeenCalled();
  });

  it("ISSUED: only ADJUSTED regulated lines are corrected", async () => {
    arrange(InvoiceStatus.SENT, [regulated("li-1"), regulated("li-3")]);
    await adjust(["li-1"]);
    const arg = ledger.correctSaleForPriceChange.mock.calls[0][0];
    expect(arg.lines.map((l: any) => l.invoiceItemId)).toEqual(["li-1"]);
  });

  it("DRAFT: re-syncs with the SAME routine update() uses, and books NO correction row", async () => {
    arrange(InvoiceStatus.DRAFT, [regulated("li-1"), ordinary("li-2")]);
    await adjust(["li-1"]);
    expect(ledger.reverseInvoiceEntries).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "inv-1", preserveReturns: true }),
    );
    expect(ledger.writeSaleEntries).toHaveBeenCalledTimes(1);
    expect(ledger.correctSaleForPriceChange).not.toHaveBeenCalled();
  });

  it("an invoice with no regulated line touches the ledger not at all, DRAFT or issued", async () => {
    for (const status of [InvoiceStatus.DRAFT, InvoiceStatus.SENT]) {
      arrange(status, [ordinary("li-2")]);
      await adjust(["li-2"]);
    }
    expect(ledger.correctSaleForPriceChange).not.toHaveBeenCalled();
    expect(ledger.reverseInvoiceEntries).not.toHaveBeenCalled();
    expect(ledger.writeSaleEntries).not.toHaveBeenCalled();
  });

  it("ATOMIC: the invoice write and the ledger write share ONE tenantTransaction and the same tx", async () => {
    arrange(InvoiceStatus.SENT, [regulated("li-1")]);
    const tx = {
      invoiceItem: { update: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
      invoice: { update: jest.fn().mockResolvedValue({}) },
    };
    tx.invoiceItem.findMany.mockResolvedValue([
      { ...regulated("li-1"), unitPrice: 5, subtotal: 50, categoryTaxAmount: 3.5 },
    ]);
    prisma.tenantTransaction.mockImplementationOnce(async (fn: any) => fn(tx));
    await adjust(["li-1"]);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(tx.invoiceItem.update).toHaveBeenCalledTimes(1);
    expect(tx.invoice.update).toHaveBeenCalledTimes(1);
    expect(ledger.correctSaleForPriceChange).toHaveBeenCalledWith(
      expect.objectContaining({ db: tx }),
    );
    // nothing was written outside the transaction
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("ATOMIC: a failing ledger write fails the adjustment (the transaction rolls both back) and nothing after it runs", async () => {
    arrange(InvoiceStatus.SENT, [regulated("li-1")]);
    ledger.correctSaleForPriceChange.mockRejectedValueOnce(new Error("ledger down"));
    await expect(adjust(["li-1"])).rejects.toThrow("ledger down");
    expect(commission.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
  });
});
