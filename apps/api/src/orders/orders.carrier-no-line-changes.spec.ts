/**
 * SA-696 (lead ruling): while an order is WITH the carrier (`carrierCancelBlockedReason` = WITH_CARRIER,
 * billing-at-shipment businesses only), ANY line-set change is a coded 409 before anything is kept:
 *  - an added line or a quantity increase  -> ORDER_WITH_CARRIER_NO_ADD ("create a new order");
 *  - a decrease, removal or product swap   -> ORDER_WITH_CARRIER_NO_REDUCE ("record a return");
 *  - price / discount / note edits stay allowed and re-sync the shipment invoice in place.
 * An UNSET-mode business and a ROUTE order are untouched. Through the real service: the staff / buyer /
 * driver `updateOrderItems` and the change-request approval share one under-lock guard
 * (`blockCredits` -> `settleStockForEdit`).
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));
// SA-434: ownership is pinned in driver-edit-access*.spec.ts; this spec is about the line-set guard.
jest.mock("./driver-edit-access", () => ({
  ...jest.requireActual("./driver-edit-access"),
  assertDriverMayEditOrder: jest.fn(),
}));

import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

const staff = { ...operatorPayload, tenantId: "t-1" } as never;
const PRODUCT = (id: string) => ({
  id,
  name: `Widget ${id}`,
  unit: "each",
  pricePerUnit: 5,
  unitsPerBox: null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
  currentStock: 100,
});
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
  status: "OUT_FOR_DELIVERY",
  fulfillPath: "SHIP",
  shippedAt: new Date("2026-10-01T00:00:00Z"),
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

describe("SA-696: no line-set change on an order with the carrier", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let invoices: {
    revertLinkedInvoicesForOrderEdit: jest.Mock;
    resyncOrderInvoicesForEdit: jest.Mock;
  };

  /**
   * What the edit has WRITTEN so far, in a transaction double that rolls back on a throw (the mock
   * client has no real transaction): `st` is restored when the callback rejects, so what is left in
   * `st.writes` is what a real database would have COMMITTED.
   */
  const st = { qty: LINE.qty, gone: false, added: [] as object[], writes: [] as string[] };
  const seed = (o: ReturnType<typeof order>) => {
    Object.assign(st, { qty: LINE.qty, gone: false, added: [], writes: [] });
    h.prisma.order.findUnique.mockImplementation(async (args: any) => {
      const sel = args?.select ? Object.keys(args.select) : [];
      if (sel.length === 1 && sel[0] === "status") return { status: o.status };
      return o;
    });
    h.prisma.order.findFirst.mockResolvedValue(o);
    h.prisma.orderItem.findMany.mockImplementation(async () => [
      ...(st.gone ? [] : [{ ...LINE, qty: st.qty }]),
      ...st.added,
    ]);
    h.prisma.orderItem.update.mockImplementation(async ({ data }: any) => {
      st.writes.push("orderItem.update");
      if (data?.qty != null) st.qty = Number(data.qty);
      return { ...LINE, qty: st.qty };
    });
    const remove = async () => {
      st.writes.push("orderItem.remove");
      st.gone = true;
      return { count: 1 };
    };
    h.prisma.orderItem.updateMany.mockImplementation(remove);
    h.prisma.orderItem.deleteMany.mockImplementation(remove);
    h.prisma.orderItem.create.mockImplementation(async ({ data }: any) => {
      st.writes.push("orderItem.create");
      const row = { ...LINE, id: "li-B", ...data };
      st.added.push(row);
      return row;
    });
    h.prisma.product.findMany.mockResolvedValue([PRODUCT("prod-A"), PRODUCT("prod-B")]);
    h.prisma.product.findUnique.mockResolvedValue(PRODUCT("prod-A"));
    const runTx = h.prisma.tenantTransaction.getMockImplementation() as (
      fn: (tx: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    h.prisma.tenantTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = { qty: st.qty, gone: st.gone, added: [...st.added], writes: [...st.writes] };
      try {
        return await runTx(fn);
      } catch (e) {
        Object.assign(st, before); // rolled back: nothing of this transaction was committed
        throw e;
      }
    });
  };
  const edit = (items: object[]) =>
    h.service.updateOrderItems("ord-1", { items, replaceAll: false } as never, staff);
  const A = { id: "li-A", productId: "prod-A" };
  /** A refused edit COMMITTED nothing (a throw inside the tx rolls every write back). */
  const noWrites = () => {
    expect(st.writes).toEqual([]);
    expect(st.added).toEqual([]);
    expect(invoices.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
    expect(invoices.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
    expect(h.prisma.orderRevision.create).not.toHaveBeenCalled();
  };
  const refused = (code: string) => ({
    status: 409,
    response: expect.objectContaining({ code }),
  });

  beforeEach(async () => {
    h = await buildOrdersService();
    (h.service as any).featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue("ship") };
    invoices = (h.service as any).invoicesService;
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
  });

  it("an added line is ORDER_WITH_CARRIER_NO_ADD, nothing written", async () => {
    seed(order());
    await expect(
      edit([
        { ...A, qty: 4 },
        { productId: "prod-B", qty: 1 },
      ]),
    ).rejects.toMatchObject(refused("ORDER_WITH_CARRIER_NO_ADD"));
    noWrites();
  });

  it("a quantity increase (+1) is ORDER_WITH_CARRIER_NO_ADD, nothing written", async () => {
    seed(order());
    await expect(edit([{ ...A, qty: 5 }])).rejects.toMatchObject(
      refused("ORDER_WITH_CARRIER_NO_ADD"),
    );
    noWrites();
  });

  it("a decrease and a removal stay ORDER_WITH_CARRIER_NO_REDUCE", async () => {
    seed(order());
    await expect(edit([{ ...A, qty: 3 }])).rejects.toMatchObject(
      refused("ORDER_WITH_CARRIER_NO_REDUCE"),
    );
    await expect(edit([{ ...A, action: "CANCEL" }])).rejects.toMatchObject(
      refused("ORDER_WITH_CARRIER_NO_REDUCE"),
    );
    noWrites();
  });

  it("a product swap is refused (it removes a line)", async () => {
    seed(order());
    await expect(
      edit([
        { ...A, action: "CANCEL" },
        { productId: "prod-B", qty: 4 },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    noWrites();
  });

  it("a PRICE / NOTE-only save (same lines, same quantities) is allowed and re-syncs the shipment invoice in place", async () => {
    seed(order());
    await edit([{ ...A, qty: 4, notes: "leave at the dock" }]);
    expect(invoices.resyncOrderInvoicesForEdit).toHaveBeenCalledWith("ord-1");
    expect(invoices.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
  });

  it("control: an UNSET-mode business is unchanged (an increase goes through)", async () => {
    (h.service as any).featureConfig.getEffectiveMode.mockResolvedValue("unset");
    seed(order());
    await expect(edit([{ ...A, qty: 5 }])).resolves.toBeDefined();
  });

  it("control: a ROUTE order is unchanged (an increase goes through)", async () => {
    seed(order({ fulfillPath: "ROUTE", shippedAt: null }));
    await expect(edit([{ ...A, qty: 5 }])).resolves.toBeDefined();
  });

  it("the change-request approval is the same guard: an approved ADD_ITEM on an order with the carrier is a 409, nothing kept", async () => {
    const o = order({
      routeRunId: "run-1",
      routeRunStopId: "stop-1",
      routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
      routeRunStop: { id: "stop-1", status: "PENDING" },
    });
    seed(o);
    h.prisma.changeRequest.findUnique.mockResolvedValue({
      id: "cr-1",
      orderId: "ord-1",
      orderItemId: null,
      productId: "prod-B",
      type: "ADD_ITEM",
      status: "PENDING",
      payload: { productId: "prod-B", qty: 1 },
    });
    h.prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
    h.prisma.product.findFirst.mockResolvedValue({ id: "prod-B", trackedCategoryId: null });
    h.prisma.product.findUnique.mockResolvedValue(PRODUCT("prod-B"));
    await expect(h.service.approveChangeRequestAtStop("cr-1", staff, null)).rejects.toMatchObject(
      refused("ORDER_WITH_CARRIER_NO_ADD"),
    );
  });
});
