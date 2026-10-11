/**
 * #3207 review D1 / D2 / D6: a carrier order's sibling write paths, through the real service.
 *  - D1: a PENDING -> DRAFT demotion of an order with the carrier is refused (it credited all the stock
 *    back, and a DRAFT can then be cancelled or deleted).
 *  - D2: a refused reduction on a reopened shipped order never reverts the shipment invoice first (the
 *    revert commits on its own connection); an allowed edit re-syncs that invoice in place.
 *  - D6: the reduction guard re-reads the status under the Order row lock (a "Mark shipped" that commits
 *    after the pre-transaction read still blocks).
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

const staff = { ...operatorPayload, tenantId: "t-1" } as never;
const PRODUCT = {
  id: "prod-A",
  name: "Widget",
  unit: "each",
  pricePerUnit: 5,
  unitsPerBox: null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
};
const LINE = {
  id: "li-A",
  orderId: "ord-1",
  productId: "prod-A",
  qty: 4,
  unitPrice: 5,
  subtotal: 20,
  status: "PENDING",
  priceType: "STANDARD",
  boxes: null,
  pieces: null,
  deliveredQty: 0,
  invoicedQty: 4,
};
const order = (over: Record<string, unknown> = {}) => ({
  id: "ord-1",
  tenantId: "t-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "CONFIRMED",
  fulfillPath: "SHIP",
  shippedAt: new Date("2026-10-01T00:00:00Z"), // shipped, delivered, then reopened
  source: "APP",
  urgent: false,
  subtotal: 20,
  tax: 0,
  total: 20,
  notes: null,
  routeRunId: null,
  routeRunStopId: null,
  customer: { businessName: "Acme" },
  lineItems: [LINE],
  ...over,
});

describe("#3207 D1/D2/D6: carrier order write paths", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let invoices: {
    revertLinkedInvoicesForOrderEdit: jest.Mock;
    resyncOrderInvoicesForEdit: jest.Mock;
    reconcileOrderDraftInvoice: jest.Mock;
  };

  const seed = (o: ReturnType<typeof order>, lockedStatus?: string) => {
    h.prisma.order.findUnique.mockImplementation(async (args: any) => {
      const sel = args?.select ? Object.keys(args.select) : [];
      // the guard's under-lock re-read (select { status })
      if (sel.length === 1 && sel[0] === "status") return { status: lockedStatus ?? o.status };
      return o;
    });
    h.prisma.order.findFirst.mockResolvedValue(o);
    // stateful line: the pre-edit read (held) sees qty 4, the post-write read sees what the edit wrote
    let qty = LINE.qty;
    h.prisma.orderItem.findMany.mockImplementation(async () => [{ ...LINE, qty }]);
    h.prisma.orderItem.update.mockImplementation(async ({ data }: any) => {
      if (data?.qty != null) qty = Number(data.qty);
      return { ...LINE, qty };
    });
    h.prisma.product.findMany.mockResolvedValue([PRODUCT]);
    h.prisma.product.findUnique.mockResolvedValue(PRODUCT);
  };
  const reopened = () =>
    h.prisma.orderRevision.findFirst.mockResolvedValue({ source: "REOPENED_FROM_DELIVERY" });
  const edit = (qty: number) =>
    h.service.updateOrderItems(
      "ord-1",
      { items: [{ id: "li-A", productId: "prod-A", qty }], replaceAll: false } as never,
      staff,
    );

  beforeEach(async () => {
    h = await buildOrdersService();
    (h.service as any).featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue("ship") };
    invoices = (h.service as any).invoicesService;
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
  });

  it("D2: a reduction of a reopened shipped order is refused BEFORE the shipment invoice is reverted", async () => {
    seed(order());
    reopened();
    await expect(edit(2)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_REDUCE" }),
    });
    expect(invoices.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
  });

  it("SA-696 (was D2): an increase on it is ORDER_WITH_CARRIER_NO_ADD, never a revert or a re-sync", async () => {
    seed(order());
    reopened();
    await expect(edit(6)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_ADD" }),
    });
    expect(invoices.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
    expect(invoices.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
  });

  it("D2: a same-quantity (price / note) save re-syncs the shipment invoice in place (never a revert)", async () => {
    seed(order());
    reopened();
    await edit(4);
    expect(invoices.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
    expect(invoices.resyncOrderInvoicesForEdit).toHaveBeenCalledWith("ord-1");
  });

  it("control: an UNSET-mode business edits exactly as before (revert first, reduction allowed)", async () => {
    (h.service as any).featureConfig.getEffectiveMode.mockResolvedValue("unset");
    seed(order());
    reopened();
    await edit(2);
    expect(invoices.revertLinkedInvoicesForOrderEdit).toHaveBeenCalledWith("ord-1");
  });

  it("D6 / #3219 S2: an order shipped between the pre-read and the row lock is refused with NOTHING reverted", async () => {
    seed(order({ shippedAt: null }), "OUT_FOR_DELIVERY"); // CONFIRMED when read, OFD under the lock
    await expect(edit(2)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_CHANGED_DURING_EDIT" }),
    });
    // the shipment invoice Mark shipped just issued is never flipped to DRAFT and stranded
    expect(invoices.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
  });

  it("#3219 S2: a ship-billing order that is not shipped reverts its invoice INSIDE the edit tx, under the lock", async () => {
    seed(order({ shippedAt: null }));
    await edit(2);
    expect(invoices.revertLinkedInvoicesForOrderEdit).toHaveBeenCalledTimes(1);
    const [id, tx, opts] = invoices.revertLinkedInvoicesForOrderEdit.mock.calls[0];
    expect(id).toBe("ord-1");
    expect(tx).toBeDefined(); // the edit's own transaction, never a separate connection
    expect(opts).toEqual({ lockRows: true });
  });

  it("#3219 S4: a replayed merge into a reopened with-carrier order re-syncs in place, as the fold did", async () => {
    seed(order({ status: "PENDING" }));
    reopened();
    await h.service.replayMergeReconcile("ord-1", "cust-1", undefined);
    expect(invoices.resyncOrderInvoicesForEdit).toHaveBeenCalledWith("ord-1");
    expect(invoices.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
  });

  it("#3219 S5: a cancel that finds the order shipped under its lock is refused, nothing cancelled", async () => {
    seed(order({ shippedAt: null }), "OUT_FOR_DELIVERY"); // CONFIRMED when read, OFD under the lock
    await expect(
      h.service.changeStatus("ord-1", { status: "CANCELLED" } as never, staff),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_CANCEL" }),
    });
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("D1: a PENDING -> DRAFT demotion of a reopened shipped order is refused before any write", async () => {
    seed(order({ status: "PENDING" }));
    reopened();
    await expect(
      h.service.changeStatus("ord-1", { status: "DRAFT", reason: "back to draft" } as never, staff),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_CANCEL" }),
    });
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("D1 control: an order that never shipped still demotes to DRAFT", async () => {
    seed(order({ status: "PENDING", shippedAt: null }));
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    await h.service.changeStatus("ord-1", { status: "DRAFT", reason: "back" } as never, staff);
    expect(h.prisma.order.updateMany).toHaveBeenCalled();
  });
});
