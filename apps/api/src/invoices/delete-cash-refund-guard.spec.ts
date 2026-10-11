/**
 * Money safety pin (W21b): deleting a sale must not erase a cash refund that already left the drawer.
 *
 * #3331 made voidInvoice and the order cancel refuse (409) when a recorded cash refund is sourced from the sale. The two DELETE
 * paths never called that guard: cash sale -> inline cash refund -> remove the payment -> delete the invoice (or the order)
 * removes the sale while the refund is already paid. deleteInvoice now asks the invoice guard right after its Order/Invoice
 * locks; deleteOrder asks the order guard first thing in its transaction. Both refuse BEFORE any write.
 */
import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { OrdersService } from "../orders/orders.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  INVOICE_HAS_CASH_REFUND_MESSAGE,
  ORDER_HAS_CASH_REFUND_MESSAGE,
} from "./invoice-cash-refund-guard";

describe("deleteInvoice: refuses a cash-refunded sale before any write", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let log: string[];
  let self: any;
  const inv = {
    id: "inv-1",
    orderId: "ord-1",
    status: "PAID",
    total: 10,
    payments: [] as unknown[],
  };

  beforeEach(() => {
    prisma = createMockPrisma();
    log = [];
    const exec = jest.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
      log.push(`lock:${strings.join("?").match(/FROM "(\w+)"/)![1]}:${vals[0]}`);
      return Promise.resolve(0);
    });
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: exec }),
    );
    prisma.invoice.findUnique.mockResolvedValue(inv);
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "line-1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.invoiceItem.deleteMany.mockResolvedValue({ count: 1 });
    prisma.invoice.delete.mockResolvedValue({});
    prisma.return.findFirst.mockImplementation(() => {
      log.push("read:cash-refund");
      return Promise.resolve(null);
    });
    self = {
      prisma,
      ledger: {
        reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined),
        syncInvoiceEntries: jest.fn(),
      },
      commissionEngine: { removeInvoiceCommission: jest.fn().mockResolvedValue(undefined) },
      gateway: { emitInvoiceUpdated: jest.fn() },
      adjustInvoicedQtyForInvoice: jest.fn().mockResolvedValue(undefined),
    };
  });

  const run = () => InvoicesService.prototype.deleteInvoice.call(self, "inv-1");

  it("409 INVOICE_HAS_CASH_REFUND when a recorded cash refund is sourced from the invoice; nothing is written", async () => {
    prisma.return.findFirst.mockResolvedValue({ id: "ret-1" });
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.INVOICE_HAS_CASH_REFUND,
      message: INVOICE_HAS_CASH_REFUND_MESSAGE,
    });
    expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invoice.delete).not.toHaveBeenCalled();
    expect(self.adjustInvoicedQtyForInvoice).not.toHaveBeenCalled();
    expect(self.ledger.reverseInvoiceEntries).not.toHaveBeenCalled();
    expect(self.gateway.emitInvoiceUpdated).not.toHaveBeenCalled();
  });

  it("asks the guard about this invoice's lines (INLINE) and its order (STANDARD), under both locks", async () => {
    await run();
    const where = prisma.return.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { kind: "INLINE", items: { some: { sourceInvoiceItemId: { in: ["line-1"] } } } },
      { kind: "STANDARD", orderId: "ord-1" },
    ]);
    expect(log.indexOf("read:cash-refund")).toBeGreaterThan(log.indexOf("lock:Invoice:inv-1"));
    expect(log.indexOf("lock:Order:ord-1")).toBeLessThan(log.indexOf("lock:Invoice:inv-1"));
  });

  it("a sale with no cash refund still deletes", async () => {
    await expect(run()).resolves.toMatchObject({ id: "inv-1" });
    expect(prisma.invoice.delete).toHaveBeenCalledTimes(1);
  });
});

describe("deleteOrder: refuses a cash-refunded order before any write", () => {
  const operator = { sub: "u1", role: "OPERATOR", tenantId: "t1" } as any;

  const harness = (cashRefund: { id: string } | null) => {
    const tx: any = {
      invoiceItem: { findMany: jest.fn().mockResolvedValue([{ id: "line-1" }]) },
      return: { findFirst: jest.fn().mockResolvedValue(cashRefund) },
      invoicePayment: { deleteMany: jest.fn() },
      invoice: { delete: jest.fn() },
    };
    const db = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: "o1",
          tenantId: "t1",
          status: OrderStatus.DELIVERED,
          fulfillPath: "ROUTE",
          shippedAt: null,
          lineItems: [],
          invoices: [{ id: "inv-1" }],
          transaction: null,
        }),
      },
      return: { count: jest.fn().mockResolvedValue(0) },
    };
    const self: any = {
      prisma: {
        forTenant: () => db,
        getTenantId: () => "t1",
        tenantTransaction: jest.fn((fn: any) => fn(tx)),
      },
      featureConfig: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
      cancelImpact: jest.fn().mockResolvedValue({ blockingPayments: [] }),
      creditNotes: { releaseOrderCreditsInTx: jest.fn() },
      invoicesService: { releaseWalletPaymentsInTx: jest.fn() },
      ledger: { reverseInvoiceEntries: jest.fn(), syncInvoiceEntries: jest.fn() },
      commissionEngine: { removeInvoiceCommission: jest.fn() },
    };
    return { self, tx };
  };

  it("409 ORDER_HAS_CASH_REFUND when a cash refund is sourced from the order's invoices; nothing is released or deleted", async () => {
    const { self, tx } = harness({ id: "ret-1" });
    const err = await (OrdersService.prototype as any).deleteOrder
      .call(self, "o1", operator)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.ORDER_HAS_CASH_REFUND,
      message: ORDER_HAS_CASH_REFUND_MESSAGE,
    });
    expect(self.creditNotes.releaseOrderCreditsInTx).not.toHaveBeenCalled();
    expect(self.invoicesService.releaseWalletPaymentsInTx).not.toHaveBeenCalled();
    expect(self.ledger.reverseInvoiceEntries).not.toHaveBeenCalled();
    expect(tx.invoicePayment.deleteMany).not.toHaveBeenCalled();
    expect(tx.invoice.delete).not.toHaveBeenCalled();
  });

  it("the guard reads this order's live invoice lines (INLINE) and the order itself (STANDARD)", async () => {
    const { self, tx } = harness({ id: "ret-1" });
    await (OrdersService.prototype as any).deleteOrder.call(self, "o1", operator).catch(() => null);
    expect(tx.return.findFirst.mock.calls[0][0].where.OR).toEqual([
      { kind: "INLINE", items: { some: { sourceInvoiceItemId: { in: ["line-1"] } } } },
      { kind: "STANDARD", orderId: "o1" },
    ]);
  });
});
