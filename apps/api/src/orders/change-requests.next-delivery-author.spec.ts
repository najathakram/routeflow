// The harness FIRST (it registers the jest.mock()s the change-requests service also loads).
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { ChangeRequestsService } from "./change-requests.service";
import { ChangeRequestResolveAction } from "./dto/resolve-change-request.dto";

/**
 * SA ruling #3418: the next-delivery rollover draft is created through create() as the buyer pseudo-user, which used to
 * stamp every line BUYER even when staff filed the request. Each rollover line's `authorChannel` now follows the
 * request's `requestedByRole` (staff/operator/driver = STAFF; customer, null or unknown = BUYER). The draft's ORDER
 * `source` stays what create() writes for the pseudo-user (APP).
 */
describe("APPROVE_NEXT_DELIVERY: the rollover line's authorChannel follows the requester", () => {
  const PRODUCT = {
    id: "prod-1",
    name: "Sample Cola",
    sku: "SC",
    unit: "each",
    pricePerUnit: 5,
    unitsPerBox: null,
    isActive: true,
    category: null,
    trackedCategoryId: null,
    trackInventory: false,
    // portal-visible, so a buyer-requested add passes the approval-time buyer gate
    kind: "STANDARD",
    portalVisible: true,
    parent: null,
  };
  const cr = (requestedByRole: string | null) => ({
    id: "cr-1",
    orderId: "ord-1",
    orderItemId: null,
    productId: "prod-1",
    type: "ADD_ITEM",
    status: "PENDING",
    payload: { productId: "prod-1", qty: 2, productName: "Sample Cola" },
    note: null,
    requestedById: "u-req",
    requestedByName: "req",
    requestedByRole,
  });

  const run = async (requestedByRole: string | null) => {
    const h = await buildOrdersService();
    const service = new ChangeRequestsService(
      h.prisma as never,
      h.service,
      { sendToCustomer: jest.fn(), sendToUser: jest.fn() } as never,
      { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) } as never,
      { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() } as never,
      h.restrictions as never,
    );
    (h.restrictions as any).restrictedProductIdsFor = jest.fn().mockResolvedValue(new Set());
    h.prisma.changeRequest.findFirst.mockResolvedValue(cr(requestedByRole));
    h.prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-100",
      status: "OUT_FOR_DELIVERY",
      lineItems: [],
      routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
    });
    h.prisma.product.findFirst.mockResolvedValue(PRODUCT);
    h.prisma.product.findMany.mockResolvedValue([PRODUCT]);
    h.prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      userId: "user-cust",
      pricingTier: 1,
      creditLimit: null,
    });
    h.prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, creditLimit: null });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.order.create.mockResolvedValue({ id: "draft-1", total: 10 });
    h.prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.changeRequest.findUnique.mockResolvedValue({
      ...cr(requestedByRole),
      status: "APPROVED",
    });
    await service.resolve(
      "ord-1",
      "cr-1",
      { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
      operatorPayload as never,
    );
    return h.prisma.order.create.mock.calls[0][0].data;
  };

  it.each([
    ["OPERATOR", "STAFF"],
    ["TENANT_ADMIN", "STAFF"],
    ["DRIVER", "STAFF"],
    ["CUSTOMER", "BUYER"],
    [null, "BUYER"],
    ["SOMETHING_NEW", "BUYER"],
  ])("a request filed by %s writes its line as %s", async (role, marker) => {
    const data = await run(role as string | null);
    expect(data.lineItems.create).toEqual([
      expect.objectContaining({ productId: "prod-1", authorChannel: marker }),
    ]);
    expect(data.source).toBe("APP"); // the ORDER-level source is unchanged (the buyer pseudo-user created it)
  });
});
