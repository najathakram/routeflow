import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * B297 (SA-098a) — `approveChangeRequestAtStop`'s ADD_ITEM new-line create() is a genuine new
 * sale (no existing line for the product), so it must stamp the rate trio the same as `create()`
 * and `createUnitLine` — never leave it null for `recomputeLineCategoryTaxes` to (not) fix later
 * (that pass only ever rewrites `categoryTaxAmount`, never the trio).
 */
describe("OrdersService.approveChangeRequestAtStop — ADD_ITEM stamps the B297 trio (SA-098a)", () => {
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
    productId: "prod-tob",
    routeRunStopId: "stop-1",
    type: "ADD_ITEM",
    status: "PENDING",
    payload: { productId: "prod-tob", qty: 3, boxes: null, pieces: null, productName: "Tobacco" },
    note: null,
  };
  const regulatedProduct = {
    id: "prod-tob",
    name: "Tobacco",
    pricePerUnit: 10,
    unitsPerBox: null,
    category: null,
    trackedCategoryId: "cat-1",
  };
  const liveCategory = {
    id: "cat-1",
    taxType: "EXCISE_PER_UNIT",
    rate: 0.5,
    priceIncludesTax: false,
  };

  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue({ ...ORDER });
    h.prisma.changeRequest.findUnique.mockResolvedValue(CR);
    h.prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1, creditLimit: null });
    h.prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    // No existing line for prod-tob → the ADD_ITEM create() branch, not the merge-into branch.
    h.prisma.orderItem.findUnique.mockResolvedValue(null);
    h.prisma.orderItem.findMany.mockResolvedValue([]);
    h.prisma.product.findUnique.mockResolvedValue(regulatedProduct); // in-tx ADD_ITEM price read
    h.prisma.product.findFirst.mockResolvedValue(regulatedProduct); // pre-tx regulated guard read
    h.prisma.trackedCategory.findMany.mockResolvedValue([liveCategory]);
  });

  it("stamps categoryTaxType/Rate/PriceIncludesTax from the live category on the new line", async () => {
    await h.service.approveChangeRequestAtStop("cr-1", operatorPayload as never, null);

    expect(h.prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
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

  it("a non-regulated product carries an all-null trio — nothing invented", async () => {
    const plain = { ...regulatedProduct, trackedCategoryId: null };
    h.prisma.product.findUnique.mockResolvedValue(plain);
    h.prisma.product.findFirst.mockResolvedValue(plain);

    await h.service.approveChangeRequestAtStop("cr-1", operatorPayload as never, null);

    expect(h.prisma.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          trackedCategoryId: null,
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: null,
        }),
      }),
    );
  });
});
