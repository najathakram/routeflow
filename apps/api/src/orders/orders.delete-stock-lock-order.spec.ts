// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { CreditNotesService } from "../credit-notes/credit-notes.service";

/**
 * B284 lock order (common/product-locks.ts house order: domain row -> Products -> anything else). A live
 * order's stock is credited back BEFORE the credit and wallet releases, exactly as the cancel does (Order,
 * Invoice, Product settle, then releases). Releasing first would let a delete hold a release row while it
 * waits on a Product a cancel already holds, a 40P01 cycle. The P21/P23 pins in orders.service.spec.ts use a
 * DELIVERED order, where the settle never runs, so this pin uses a PENDING one.
 */
describe("deleteOrder: a live order's stock unwind precedes the credit and wallet releases (B284)", () => {
  it("settleStockForEdit(..., notes DELETE) is called once, before releaseOrderCreditsInTx and releaseWalletPaymentsInTx", async () => {
    const h = await buildOrdersService();
    const { prisma, service } = h;
    const pending = {
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      status: "PENDING",
      invoices: [{ id: "inv-1" }],
      transaction: null,
    };
    prisma.order.findUnique.mockResolvedValue(pending as never);
    prisma.order.findFirst.mockResolvedValue(pending as never);
    prisma.creditNote.findMany.mockResolvedValue([] as never);
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "p-1", qty: 3 },
    ] as never);
    const settle = jest.spyOn(service as any, "settleStockForEdit").mockResolvedValue(undefined);
    const creditNotes = h.module.get(CreditNotesService) as unknown as {
      releaseOrderCreditsInTx: jest.Mock;
    };
    const invoices = (service as any).invoicesService as { releaseWalletPaymentsInTx: jest.Mock };

    await service.deleteOrder("ord-1", operatorPayload as never);

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      { id: "ord-1", status: "PENDING" },
      [{ id: "li-1", productId: "p-1", qty: 3 }],
      [],
      operatorPayload,
      { notes: "DELETE" },
    );
    const settleAt = settle.mock.invocationCallOrder[0];
    expect(creditNotes.releaseOrderCreditsInTx).toHaveBeenCalled();
    expect(settleAt).toBeLessThan(creditNotes.releaseOrderCreditsInTx.mock.invocationCallOrder[0]);
    expect(settleAt).toBeLessThan(invoices.releaseWalletPaymentsInTx.mock.invocationCallOrder[0]);
  });
});
