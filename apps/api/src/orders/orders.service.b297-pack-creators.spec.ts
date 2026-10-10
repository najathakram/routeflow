import {
  buildOrdersService,
  operatorPayload,
  customerPayload,
} from "./testing/orders-service-harness";

/**
 * B297 (SA-098a/SA-100 hardening) — the four pack-line (non-unit-aware) writers inside
 * `updateOrderItems` that each need their OWN scoped `loadCategoryMapForProducts` call
 * (disconnected from `uctx.categoryMap`, which only covers unit-aware products): buyer/driver
 * replace-all create, staff replace-all create, diff-add create, and the pack-line substitute
 * update. Full jest / tsc passing doesn't prove these specific `data` objects carry the trio —
 * only an assertion on the actual `orderItem.create`/`update` call does.
 */
const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "DRAFT" as const,
  source: "APP" as const,
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

const regulatedProduct = {
  id: "prod-tob",
  pricePerUnit: 7,
  unitsPerBox: null,
  trackedCategoryId: "cat-1",
};
const liveCategory = {
  id: "cat-1",
  taxType: "EXCISE_PER_UNIT",
  rate: 0.5,
  priceIncludesTax: false,
};

const existingPlainLine = {
  id: "li-A",
  orderId: "ord-1",
  productId: "prod-A",
  qty: 2,
  unitPrice: 5,
  subtotal: 10,
  status: "PENDING",
  boxes: null,
  pieces: null,
  trackedCategoryId: null,
};

const expectTrio = (data: any) =>
  expect(data).toEqual(
    expect.objectContaining({
      trackedCategoryId: "cat-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.5,
      categoryPriceIncludesTax: false,
    }),
  );

describe("OrdersService.updateOrderItems — pack-line creators stamp the B297 trio (SA-100)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 7, status: "PENDING" }]);
  });

  it("buyer/driver replace-all: a fresh regulated pack line is stamped from the live category", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      customerId: "cust-1",
      lineItems: [],
    });
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.product.findMany.mockResolvedValue([regulatedProduct]);
    h.prisma.trackedCategory.findMany.mockResolvedValue([liveCategory]);

    await h.service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-tob", qty: 1 }] } as never,
      { ...customerPayload, sub: "user-cust" } as never,
    );

    const call = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-tob",
    );
    expect(call).toBeDefined();
    expectTrio(call![0].data);
  });

  it("staff replace-all: a fresh regulated pack line is stamped from the live category", async () => {
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [] });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([regulatedProduct]);
    h.prisma.trackedCategory.findMany.mockResolvedValue([liveCategory]);

    await h.service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-tob", qty: 1, unitPrice: 7 }], replaceAll: true } as never,
      operatorPayload as never,
    );

    const call = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-tob",
    );
    expect(call).toBeDefined();
    expectTrio(call![0].data);
  });

  it("diff-add: a fresh regulated pack line is stamped from the live category", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [existingPlainLine],
    });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findUnique.mockResolvedValue(regulatedProduct);
    h.prisma.product.findMany.mockResolvedValue([regulatedProduct]);
    h.prisma.trackedCategory.findMany.mockResolvedValue([liveCategory]);

    await h.service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-tob", qty: 1 }], replaceAll: false } as never,
      operatorPayload as never,
    );

    const call = h.prisma.orderItem.create.mock.calls.find(
      (c: any) => c[0]?.data?.productId === "prod-tob",
    );
    expect(call).toBeDefined();
    expectTrio(call![0].data);
  });

  it("pack-line substitute: re-stamps the trio from the NEW product's live category", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [existingPlainLine],
    });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findUniqueOrThrow.mockResolvedValue(regulatedProduct);
    h.prisma.trackedCategory.findMany.mockResolvedValue([liveCategory]);

    await h.service.updateOrderItems(
      "ord-1",
      {
        items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 2 }],
        replaceAll: false,
      } as never,
      operatorPayload as never,
    );

    expect(h.prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "li-A", orderId: "ord-1" },
        data: expect.objectContaining({
          productId: "prod-tob",
          trackedCategoryId: "cat-1",
          categoryTaxType: "EXCISE_PER_UNIT",
          categoryTaxRate: 0.5,
          categoryPriceIncludesTax: false,
        }),
      }),
    );
  });
});
