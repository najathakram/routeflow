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

import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { assertNotOverpaidByPriceChange } from "./price-adjustment-ledger";

const INV = { id: "inv-1", invoiceNumber: "INV-1" };
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
      $executeRaw: jest.fn().mockResolvedValue(1),
      trackedCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: 0.07, priceIncludesTax: false },
          ]),
      },
      product: { findMany: jest.fn().mockResolvedValue([]) },

      invoiceItem: { update: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
      invoice: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn() },
    };
    tx.invoice.findUnique.mockResolvedValue(null);
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

  it("N-3: the Invoice row is locked FIRST, before any InvoiceItem write, and status/payments are re-read under the lock", async () => {
    arrange(InvoiceStatus.SENT, [regulated("li-1")]);
    const order: string[] = [];
    const tx = {
      trackedCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: 0.07, priceIncludesTax: false },
          ]),
      },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      $executeRaw: jest.fn(async () => {
        order.push("lock invoice");
        return 1;
      }),
      invoiceItem: {
        update: jest.fn(async () => {
          order.push("write item");
          return {};
        }),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { ...regulated("li-1"), unitPrice: 5, subtotal: 50, categoryTaxAmount: 3.5 },
          ]),
      },
      invoice: {
        update: jest.fn().mockResolvedValue({}),
        // a payment landed after the pre-tx read: the fresh copy under the lock carries it. It settles
        // the new $53.50 total exactly (B1051: a payment ABOVE the new total is now refused)
        findUnique: jest.fn(async () => {
          order.push("reread invoice");
          return {
            status: InvoiceStatus.SENT,
            items: [regulated("li-1")],
            payments: [{ status: "PAID", amount: 53.5 }],
          };
        }),
      },
    };
    prisma.tenantTransaction.mockImplementationOnce(async (fn: any) => fn(tx));
    await adjust(["li-1"]);
    expect(order.slice(0, 3)).toEqual(["lock invoice", "reread invoice", "write item"]);
    expect(tx.invoice.update.mock.calls[0][0].data.status).toBe(InvoiceStatus.PAID);
  });

  describe("N-1 / N-2: everything is re-read UNDER the Invoice lock", () => {
    const txWith = (live: any) => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        trackedCategory: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: 0.07, priceIncludesTax: false },
            ]),
        },
        product: { findMany: jest.fn().mockResolvedValue([]) },

        invoiceItem: {
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([]),
        },
        invoice: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(live),
        },
      };
      prisma.tenantTransaction.mockImplementationOnce(async (fn: any) => fn(tx));
      return tx;
    };

    it("N-1: a payment or write-off that landed after the pre-lock read (now PAID) is a 409 and nothing is written", async () => {
      arrange(InvoiceStatus.SENT, [regulated("li-1")]);
      const tx = txWith({ status: InvoiceStatus.PAID, items: [regulated("li-1")], payments: [] });
      await expect(adjust(["li-1"])).rejects.toThrow(ConflictException);
      expect(tx.invoiceItem.update).not.toHaveBeenCalled();
      expect(tx.invoice.update).not.toHaveBeenCalled();
      expect(ledger.correctSaleForPriceChange).not.toHaveBeenCalled();
    });

    it("N-2: a line added or removed since the pre-lock read is a 409, not a stale re-price", async () => {
      arrange(InvoiceStatus.SENT, [regulated("li-1")]);
      const tx = txWith({
        status: InvoiceStatus.SENT,
        items: [regulated("li-1"), regulated("li-2")],
        payments: [],
      });
      await expect(adjust(["li-1"])).rejects.toThrow(ConflictException);
      expect(tx.invoiceItem.update).not.toHaveBeenCalled();
    });

    it("N-2: the category and pack reference data come from the LOCKED read (a line whose category changed under the same id)", async () => {
      arrange(InvoiceStatus.SENT, [regulated("li-1")]); // pre-lock: cat-1
      const tx = txWith({
        status: InvoiceStatus.SENT,
        items: [regulated("li-1", { trackedCategoryId: "cat-2", productId: "p-other" })],
        payments: [],
      });
      await adjust(["li-1"]);
      expect(tx.trackedCategory.findMany).toHaveBeenCalledWith({
        where: { id: { in: ["cat-2"] } },
      });
      expect(tx.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ["p-other"] } } }),
      );
      expect(prisma.trackedCategory.findMany).not.toHaveBeenCalled(); // nothing read pre-lock
    });

    it("N-2: the writes are built from the lines re-read under the lock (their live quantity, not the pre-lock copy)", async () => {
      arrange(InvoiceStatus.SENT, [regulated("li-1")]); // pre-lock qty 10, subtotal 100
      const tx = txWith({
        status: InvoiceStatus.SENT,
        items: [regulated("li-1", { qty: 20, subtotal: 200 })], // edited to 20 meanwhile
        payments: [],
      });
      await adjust(["li-1"]);
      const data = tx.invoiceItem.update.mock.calls[0][0].data;
      expect(Number(data.subtotal)).toBe(100); // 20 x the new $5, not 10 x $5
    });
  });

  it("ATOMIC: a failing ledger write fails the adjustment (the transaction rolls both back) and nothing after it runs", async () => {
    arrange(InvoiceStatus.SENT, [regulated("li-1")]);
    ledger.correctSaleForPriceChange.mockRejectedValueOnce(new Error("ledger down"));
    await expect(adjust(["li-1"])).rejects.toThrow("ledger down");
    expect(commission.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
  });
});

// B1051: the overpayment guard's cent arithmetic. The end-to-end proof (a $150 -> $80 re-price of a
// PARTIAL invoice with $100 paid) is price-adjustment-overpay-b1051.db.spec.ts.
describe("assertNotOverpaidByPriceChange (B1051)", () => {
  it("refuses a new total below the confirmed payments and names the exact overage", () => {
    expect(() => assertNotOverpaidByPriceChange(100, 80, INV)).toThrow(BadRequestException);
    expect(() => assertNotOverpaidByPriceChange(100, 80, INV)).toThrow("overpaid by $20.00");
    expect(() => assertNotOverpaidByPriceChange(100.01, 100, INV)).toThrow("overpaid by $0.01");
  });

  it("allows a new total equal to, or above, the confirmed payments", () => {
    expect(() => assertNotOverpaidByPriceChange(80, 80, INV)).not.toThrow();
    expect(() => assertNotOverpaidByPriceChange(60, 80, INV)).not.toThrow();
    expect(() => assertNotOverpaidByPriceChange(0, 80, INV)).not.toThrow();
  });

  it("compares in cents: float noise on the paid sum is not an overpayment", () => {
    expect(0.1 + 0.2 > 0.3).toBe(true); // the raw comparison WOULD refuse
    expect(() => assertNotOverpaidByPriceChange(0.1 + 0.2, 0.3, INV)).not.toThrow();
  });
});
