// SA-434: these driver cases pin OTHER behaviour; ownership is pinned in driver-edit-access*.spec.ts.
jest.mock("./driver-edit-access", () => ({
  ...jest.requireActual("./driver-edit-access"),
  assertDriverMayEditOrder: jest.fn(),
}));
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * B673 / B753 — what the AT-STOP path does with a driver's door add, which carries
 * `{ qty: total pieces, boxes, pieces }`.
 *
 * B673 fixed the NEXT-DELIVERY rollover (change-requests.service.ts); these pin the at-stop side
 * of the same payloads. Its new-line branch is correct today. Its MERGE branch is B753: it adds
 * `payload.qty` to `existing.qty` without reading the split, so it mixes axes whenever the two
 * producers (driver: pieces + split; buyer: bare boxes) and the existing line's shape (box-split
 * vs box-unaware) disagree. The two merge cases PIN TODAY'S WRONG VALUES ($520 and $43.33) as plain
 * `it` tests: `it.failing` would pass on ANY error, a broken setup included, so it could not tell
 * the defect from a harness fault. These go RED the day B753 changes that math — whoever fixes
 * B753 then flips each assertion to the correct $80.
 *
 * Its own file (not orders.service.spec.ts) because that spec is pinned at its size-ratchet
 * ceiling; `buildOrdersService` is the shared at-stop harness.
 */
describe("OrdersService.approveChangeRequestAtStop — a door add's box split (B673 / B753)", () => {
  const driver = { ...operatorPayload, role: "DRIVER" } as never;

  const PRODUCT = {
    id: "prod-1",
    name: "Sample Cola 12pk",
    pricePerUnit: 40,
    unitsPerBox: 12,
    category: null,
    trackedCategoryId: null,
  };

  const order = (lineItems: object[]) => ({
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-123",
    status: "OUT_FOR_DELIVERY",
    subtotal: 40,
    tax: 0,
    total: 40,
    routeRunId: "run-1",
    routeRunStopId: "stop-1",
    lineItems,
    routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
    routeRunStop: { id: "stop-1", status: "PENDING" },
  });

  const addItem = (payload: object, requestedByRole = "DRIVER") => ({
    id: "cr-1",
    tenantId: "test-tenant",
    orderId: "ord-1",
    orderItemId: null,
    productId: "prod-1",
    routeRunStopId: "stop-1",
    type: "ADD_ITEM",
    status: "PENDING",
    payload: { productId: "prod-1", ...payload },
    note: null,
    requestedById: "user-x",
    requestedByName: "someone",
    requestedByRole,
  });

  let h: Awaited<ReturnType<typeof buildOrdersService>>;

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1, creditLimit: null });
    h.prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    h.prisma.product.findUnique.mockResolvedValue(PRODUCT); // in-tx ADD_ITEM price read
    h.prisma.product.findFirst.mockResolvedValue(PRODUCT); // pre-tx regulated guard read
  });

  /** Merge a CR into one existing same-product line, read back under the B135 row lock. */
  const mergeInto = (line: Record<string, unknown>) => {
    h.prisma.order.findUnique.mockResolvedValue(order([line]));
    h.prisma.orderItem.findMany
      .mockResolvedValueOnce([]) // getCustomerPriceHistory (hoisted, pre-tx)
      .mockResolvedValue([{ ...line, trackedCategoryId: null }]);
    h.prisma.orderItem.findUnique.mockResolvedValue(line);
  };

  it("PIN-B673-3: an at-stop NEW line for 1 box of a 12-pack (qty 12 + split 1/0) is billed $40", async () => {
    h.prisma.changeRequest.findUnique.mockResolvedValue(
      addItem({ qty: 12, boxes: 1, pieces: 0, productName: "Sample Cola 12pk" }),
    );
    h.prisma.order.findUnique.mockResolvedValue(order([])); // no existing line for prod-1
    h.prisma.orderItem.create.mockResolvedValue({ id: "li-new" });
    h.prisma.orderItem.findMany.mockResolvedValueOnce([]).mockResolvedValue([
      {
        id: "li-new",
        productId: "prod-1",
        qty: 12,
        unitPrice: 40,
        subtotal: 40,
        status: "PENDING",
        trackedCategoryId: null,
      },
    ]);

    await h.service.approveChangeRequestAtStop("cr-1", driver, null);

    expect(h.prisma.orderItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ qty: 12, boxes: 1, pieces: 0, subtotal: 40 }),
    });
  });

  it("B753(a) — TODAY'S WRONG VALUE, pinned: a driver's 1 box merged into a LEGACY box-unaware line of 1 box bills $520 (correct: $80)", async () => {
    h.prisma.changeRequest.findUnique.mockResolvedValue(addItem({ qty: 12, boxes: 1, pieces: 0 }));
    mergeInto({
      id: "li-1",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 1, // a box-unaware boxed line: qty IS the box count
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 40,
      subtotal: 40,
      status: "PENDING",
      deliveredQty: 0,
    });

    await h.service.approveChangeRequestAtStop("cr-1", driver, null);

    expect(h.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      // B753: 13 bare 'boxes' at $40. Correct is 2 boxes = $80.
      data: expect.objectContaining({ subtotal: 520 }),
    });
  });

  it("B753(b) — TODAY'S WRONG VALUE, pinned: a buyer's bare 1 (a box) merged into a box-SPLIT line of 1 box bills $43.33 (correct: $80)", async () => {
    h.prisma.changeRequest.findUnique.mockResolvedValue(
      addItem({ qty: 1, boxes: null, pieces: null }, "CUSTOMER"),
    );
    mergeInto({
      id: "li-1",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 12, // a box-split line: qty is total pieces
      boxes: 1,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: 40,
      subtotal: 40,
      status: "PENDING",
      deliveredQty: 0,
    });

    await h.service.approveChangeRequestAtStop("cr-1", operatorPayload as never, null);

    expect(h.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      // B753: 13 pieces = 1 box + 1 piece. Correct is 2 boxes = $80.
      data: expect.objectContaining({ subtotal: 43.33 }),
    });
  });
});
