// The harness FIRST: it jest.mock()s modules (notifications, invoices) that change-requests.service
// also imports, and those mocks must be registered before anything loads the real modules.
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { ChangeRequestsService } from "./change-requests.service";
import { ChangeRequestResolveAction } from "./dto/resolve-change-request.dto";

/**
 * B673 — the next-delivery rollover of a driver's door add, run through the REAL
 * `OrdersService.create()`.
 *
 * change-requests.service.spec.ts prices create()'s items with `priceLikeCreate`, a hand copy of
 * create()'s split predicate and pricing call. A hand copy can drift from the thing it copies, so
 * this pins the same money end to end: the real ChangeRequestsService hands the filed split to the
 * real create() (on the shared buildOrdersService harness, Prisma mocked), and the line create()
 * writes is asserted directly. On master this wrote qty 12 with no split and a $480 subtotal.
 */
describe("B673 — APPROVE_NEXT_DELIVERY of a door add, through the real create() (REG-B673)", () => {
  const BOXED = {
    id: "prod-1",
    name: "Sample Cola 12pk",
    sku: "SC12",
    unit: "each",
    pricePerUnit: 40, // the BOX price for a boxed product
    unitsPerBox: 12,
    isActive: true,
    category: null,
    trackedCategoryId: null,
    trackInventory: false,
  };

  const DOOR_ADD = {
    id: "cr-1",
    orderId: "ord-1",
    orderItemId: null,
    productId: "prod-1",
    type: "ADD_ITEM",
    status: "PENDING",
    payload: {
      productId: "prod-1",
      qty: 12,
      boxes: 1,
      pieces: 0,
      productName: "Sample Cola 12pk",
    },
    note: null,
    requestedById: "user-drv",
    requestedByName: "driver1",
    requestedByRole: "DRIVER",
  };

  it("REG-B673-real: 1 box of a 12-pack at $40 is written by create() as 1 box / 12 pieces, subtotal $40", async () => {
    const h = await buildOrdersService();
    const service = new ChangeRequestsService(
      h.prisma as never,
      h.service,
      { sendToCustomer: jest.fn(), sendToUser: jest.fn() } as never,
      { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) } as never,
      { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() } as never,
      h.restrictions as never,
    );

    h.prisma.changeRequest.findFirst.mockResolvedValue(DOOR_ADD);
    h.prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-100",
      status: "OUT_FOR_DELIVERY",
      lineItems: [],
      routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
    });
    // The CR service reads the product twice (license guard, then the live pack for the split);
    // create() reads its catalog rows with findMany.
    h.prisma.product.findFirst.mockResolvedValue(BOXED);
    h.prisma.product.findMany.mockResolvedValue([BOXED]);
    // One customer row serves the CR service's pseudo-buyer lookup and create()'s own reads.
    h.prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      userId: "user-cust",
      pricingTier: 1,
      creditLimit: null,
    });
    h.prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, creditLimit: null });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.order.create.mockResolvedValue({ id: "draft-1", total: 40 });
    h.prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.changeRequest.findUnique.mockResolvedValue({ ...DOOR_ADD, status: "APPROVED" });

    await service.resolve(
      "ord-1",
      "cr-1",
      { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
      operatorPayload as never,
    );

    const data = h.prisma.order.create.mock.calls[0][0].data;
    expect(data.lineItems.create).toEqual([
      expect.objectContaining({ productId: "prod-1", qty: 12, boxes: 1, pieces: 0, subtotal: 40 }),
    ]);
    expect(data.subtotal).toBe(40);
  });
});
