import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { InvoicesService } from "../invoices/invoices.service";

/**
 * B1372 N2 (SA-1177 A2 K3), through the REAL updateOrderItems with the harness' mock Prisma: the in-transaction invoice
 * revert is asked to enforce the confirm (`requireAck`) exactly when a staff editor saved without `ackSentRevert`. The
 * 409 itself is pinned on the seam (order-edit-revert-set.ack.spec.ts). Placeholders only.
 */
const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 20,
  tax: 0,
  total: 20,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Acme Wholesale" },
};
const line = {
  id: "li-1",
  orderId: "ord-1",
  productId: "prod-A",
  qty: 2,
  unitPrice: 10,
  subtotal: 20,
  status: "PENDING",
  boxes: null,
  pieces: null,
  unitLabel: null,
  invoicedQty: 0,
  deliveredQty: 0,
  trackedCategoryId: null,
};
const product = { id: "prod-A", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null };

describe("updateOrderItems: the sent-revert confirm is enforced in the transaction (B1372 N2)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let invoices: InvoicesService;
  beforeEach(async () => {
    h = await buildOrdersService();
    invoices = h.module.get(InvoicesService);
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [line] });
    h.prisma.orderItem.findMany.mockResolvedValue([line]);
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([product]);
    h.prisma.product.findUnique.mockResolvedValue(product);
    h.prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: 3 } });
  });
  const inTxCall = () =>
    (invoices.revertLinkedInvoicesForOrderEdit as jest.Mock).mock.calls.find(
      (c) => c[1] !== undefined && c[2]?.lockRows,
    );
  const edit = (dto: Record<string, unknown>, user: unknown = operatorPayload, opts?: object) =>
    h.service.updateOrderItems("ord-1", dto as never, user as never, opts as never);

  it("PIN: a staff edit with no ack asks the in-tx revert to require it", async () => {
    await edit({ items: [{ id: "li-1", qty: 3 }] });
    expect(inTxCall()?.[2]).toEqual({ lockRows: true, requireAck: true });
  });

  it("with ackSentRevert: the revert runs as today", async () => {
    await edit({ items: [{ id: "li-1", qty: 3 }], ackSentRevert: true });
    expect(inTxCall()?.[2]).toEqual({ lockRows: true, requireAck: false });
  });

  it("the create path's own auto-merge is never asked", async () => {
    await edit({ items: [{ id: "li-1", qty: 3 }] }, operatorPayload, { isCreateMerge: true });
    expect(inTxCall()?.[2]).toEqual({ lockRows: true, requireAck: false });
  });
});
