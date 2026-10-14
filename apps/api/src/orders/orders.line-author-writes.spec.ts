import {
  buildOrdersService,
  operatorPayload,
  customerPayload,
} from "./testing/orders-service-harness";

/**
 * SA ruling (#3418): every OrderItem write of `updateOrderItems` and of the at-door change-request approval sets the
 * explicit `authorChannel` from the ACTING principal. Replace-all RE-CREATES every line, so a line the order already
 * had keeps its prior marker (a staff edit never launders a buyer line; a buyer lowering a staff line does not take it
 * over); only a product new to the order, or a BUYER's raise, takes the editor's marker. Asserted on the data handed
 * to Prisma.
 */
const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "DRAFT" as const,
  source: "PHONE" as const,
  sourceRecorded: true,
  urgent: false,
  subtotal: 0,
  tax: 0,
  total: 0,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Acme Wholesale" },
};
const product = (id: string) => ({
  id,
  pricePerUnit: 7,
  unitsPerBox: null,
  trackedCategoryId: null,
});
const priorLine = (productId: string, authorChannel: string | null, qty = 2) => ({
  id: `li-${productId}`,
  orderId: "ord-1",
  productId,
  qty,
  unitPrice: 7,
  subtotal: 7 * qty,
  status: "PENDING",
  boxes: null,
  pieces: null,
  trackedCategoryId: null,
  authorChannel,
});

describe("updateOrderItems writes authorChannel from the acting principal (SA ruling #3418)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const createdFor = (productId: string) =>
    h.prisma.orderItem.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.productId === productId);
  /** The LOCKED read (`heldItems`, the only one that selects authorChannel) sees `held`; every other read a stub. */
  const holding = (held: unknown[]) =>
    h.prisma.orderItem.findMany.mockImplementation((a: any) =>
      Promise.resolve(a?.select?.authorChannel ? held : [{ subtotal: 7, status: "PENDING" }]),
    );

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 7, status: "PENDING" }]);
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.trackedCategory.findMany.mockResolvedValue([]);
  });

  it("buyer replace-all: a NEW product is BUYER; a staff line the buyer lowered stays STAFF", async () => {
    const held = [priorLine("p-staff", "STAFF", 4)];
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: held });
    holding(held);
    h.prisma.product.findMany.mockResolvedValue([product("p-staff"), product("p-new")]);
    await h.service.updateOrderItems(
      "ord-1",
      {
        items: [
          { productId: "p-staff", qty: 1 },
          { productId: "p-new", qty: 1 },
        ],
      } as never,
      { ...customerPayload, sub: "user-cust" } as never,
    );
    expect(createdFor("p-new")?.authorChannel).toBe("BUYER");
    expect(createdFor("p-staff")?.authorChannel).toBe("STAFF");
  });

  it("buyer replace-all: a staff line the buyer RAISED becomes BUYER", async () => {
    const held = [priorLine("p-staff", "STAFF", 1)];
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: held });
    holding(held);
    h.prisma.product.findMany.mockResolvedValue([product("p-staff")]);
    await h.service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "p-staff", qty: 5 }] } as never,
      { ...customerPayload, sub: "user-cust" } as never,
    );
    expect(createdFor("p-staff")?.authorChannel).toBe("BUYER");
  });

  it("staff replace-all: a buyer line stays BUYER even when raised; a NEW product is STAFF", async () => {
    const held = [priorLine("p-buyer", "BUYER", 1)];
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: held });
    holding(held);
    h.prisma.product.findMany.mockResolvedValue([product("p-buyer"), product("p-new")]);
    await h.service.updateOrderItems(
      "ord-1",
      {
        items: [
          { productId: "p-buyer", qty: 9, unitPrice: 7 },
          { productId: "p-new", qty: 1, unitPrice: 7 },
        ],
        replaceAll: true,
      } as never,
      operatorPayload as never,
    );
    expect(createdFor("p-buyer")?.authorChannel).toBe("BUYER");
    expect(createdFor("p-new")?.authorChannel).toBe("STAFF");
  });

  it("staff diff-add: the added line is STAFF", async () => {
    const held = [priorLine("p-old", null)];
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: held });
    holding(held);
    h.prisma.product.findMany.mockResolvedValue([product("p-add")]);
    await h.service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "p-add", qty: 1 }], replaceAll: false } as never,
      operatorPayload as never,
    );
    expect(createdFor("p-add")?.authorChannel).toBe("STAFF");
  });
});

describe("approveChangeRequestAtStop writes the requester's authorChannel (SA ruling #3418)", () => {
  const ORDER = {
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-1",
    status: "OUT_FOR_DELIVERY",
    subtotal: 0,
    tax: 0,
    total: 0,
    routeRunId: "run-1",
    routeRunStopId: "stop-1",
    lineItems: [] as any[],
    routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
    routeRunStop: { id: "stop-1", status: "PENDING" },
  };
  const CR = {
    id: "cr-1",
    orderId: "ord-1",
    orderItemId: null,
    productId: "prod-x",
    routeRunStopId: "stop-1",
    type: "ADD_ITEM",
    status: "PENDING",
    payload: { productId: "prod-x", qty: 3, boxes: null, pieces: null, productName: "X" },
    note: null,
  };
  const prod = {
    id: "prod-x",
    name: "X",
    pricePerUnit: 10,
    unitsPerBox: null,
    category: null,
    trackedCategoryId: null,
  };
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue({ ...ORDER });
    h.prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1, creditLimit: null });
    h.prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    h.prisma.orderItem.findUnique.mockResolvedValue(null);
    h.prisma.orderItem.findMany.mockResolvedValue([]);
    h.prisma.product.findUnique.mockResolvedValue(prod);
    h.prisma.product.findFirst.mockResolvedValue(prod);
    h.prisma.trackedCategory.findMany.mockResolvedValue([]);
  });

  it.each([
    ["CUSTOMER", "BUYER"],
    [null, "BUYER"],
    ["OPERATOR", "STAFF"],
  ])("ADD_ITEM requested by %s writes %s", async (requestedByRole, expected) => {
    h.prisma.changeRequest.findUnique.mockResolvedValue({ ...CR, requestedByRole });
    await h.service.approveChangeRequestAtStop("cr-1", operatorPayload as never, null);
    expect(h.prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ productId: "prod-x", authorChannel: expected }),
      }),
    );
  });
});
