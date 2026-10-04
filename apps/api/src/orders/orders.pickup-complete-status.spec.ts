import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { InventoryService } from "../inventory/inventory.service";

/**
 * SA-655 item 11, the premise of POST /orders/:id/pickup-complete: the EXISTING changeStatus moves a
 * PICKUP order to DELIVERED from CONFIRMED or OUT_FOR_DELIVERY with NO stock movement (the one decrement
 * was create()'s) and exactly ONE invoice path (reconcile the pending mirror, else auto-create) — never both.
 */
describe("OrdersService.changeStatus — PICKUP order to DELIVERED", () => {
  const order = (status: string) => ({
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-123",
    status,
    fulfillPath: "PICKUP",
    routeRunId: null,
    routeRunStopId: null,
    total: 16.47,
    deliveredAt: null,
    orderDate: new Date("2026-10-04T12:00:00Z"),
    customer: { businessName: "Acme Co" },
  });

  async function run(from: string, draft: boolean) {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue(order(from));
    h.prisma.order.update.mockResolvedValue({ ...order("DELIVERED"), status: "DELIVERED" });
    const invoices = (h.service as any).invoicesService;
    invoices.findOpenOrderDraft.mockResolvedValue(draft ? { id: "d1" } : null);
    const decrement = jest.spyOn(h.service as any, "decrementStockForSale");
    const settle = jest.spyOn(h.service as any, "settleStockForEdit");
    await h.service.changeStatus(
      "ord-1",
      { status: "DELIVERED" as never },
      operatorPayload as never,
    );
    return { h, invoices, decrement, settle };
  }

  it.each(["CONFIRMED", "OUT_FOR_DELIVERY"])(
    "%s -> DELIVERED writes the status and no stock movement",
    async (from) => {
      const { h, decrement, settle } = await run(from, false);
      expect(h.prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "DELIVERED" }) }),
      );
      expect(decrement).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect((h.module.get(InventoryService) as any).recordSale).not.toHaveBeenCalled();
    },
  );

  it.each(["CONFIRMED", "OUT_FOR_DELIVERY"])(
    "%s -> DELIVERED with no mirror auto-creates exactly one invoice",
    async (from) => {
      const { invoices } = await run(from, false);
      expect(invoices.createInvoiceFromOrderWithTenant).toHaveBeenCalledTimes(1);
      expect(invoices.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
      expect(invoices.send).not.toHaveBeenCalled();
    },
  );

  it("with a pending mirror draft it reconciles that draft and creates no second invoice", async () => {
    const { invoices } = await run("OUT_FOR_DELIVERY", true);
    expect(invoices.reconcileOrderDraftInvoice).toHaveBeenCalledWith("ord-1", { basis: "order" });
    expect(invoices.createInvoiceFromOrderWithTenant).not.toHaveBeenCalled();
    expect(invoices.send).not.toHaveBeenCalled();
  });
});
