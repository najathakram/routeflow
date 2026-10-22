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
 * of the same payloads. Its MERGE branch was B753: it added `payload.qty` to `existing.qty` without
 * reading the split. SA-841 routes it through `mergeIntoStoredLine` (stored-line-merge.ts): both
 * sides in pieces at the line's OWN pack, a box-unaware line kept box-unaware, a pack the door
 * cannot reconcile refused 409. The two once-pinned wrong values ($520, $43.33) now read $80.
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

  const conflictCode = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return ((e as { getResponse?: () => { code?: string; message?: string } }).getResponse?.() ??
        {}) as { code?: string; message?: string };
    }
    throw new Error("expected a refusal");
  };

  it("B753(a) / SA-841 F1: a driver's 1 box merged into a box-unaware line of 1 box bills 2 boxes = $80, never $520", async () => {
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
      // SA-104: a box-unaware line is never promoted at the door; it gains whole boxes.
      data: expect.objectContaining({
        qty: 2,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        subtotal: 80,
      }),
    });
    // the delivery record is in the line's own unit: 1 box added
    expect(h.prisma.deliveryMutation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderItemId: "li-1", qty: 1 }),
    });
  });

  it("B753(b) / SA-841 F2: a buyer's bare 1 (a box) merged into a box-SPLIT line of 1 box bills 2 boxes = $80, never $43.33", async () => {
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
      data: expect.objectContaining({
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12,
        subtotal: 80,
      }),
    });
  });

  it("SA-841 R3: a driver's 1 box + 6 into a split line sold as a 12-pack keeps the stored 12, never the live 6 ($140, not $280)", async () => {
    h.prisma.product.findUnique.mockResolvedValue({ ...PRODUCT, unitsPerBox: 6 }); // repacked since the sale
    h.prisma.product.findFirst.mockResolvedValue({ ...PRODUCT, unitsPerBox: 6 });
    h.prisma.changeRequest.findUnique.mockResolvedValue(addItem({ qty: 18, boxes: 1, pieces: 6 }));
    mergeInto({
      id: "li-1",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 24, // 2 boxes of 12, pack never stamped: it is recovered from the line's own split
      boxes: 2,
      pieces: 0,
      unitsPerBox: null,
      unitPrice: 40,
      subtotal: 80,
      status: "PENDING",
      deliveredQty: 0,
    });

    await h.service.approveChangeRequestAtStop("cr-1", driver, null);

    expect(h.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      data: expect.objectContaining({
        qty: 42,
        boxes: 3,
        pieces: 6,
        unitsPerBox: 12,
        subtotal: 140,
      }),
    });
  });

  it("SA-841 R4: a buyer's bare 1 into a 12-pack line of a product repacked to 6 is refused 409 MERGE_PACK_MISMATCH naming both packs, nothing written", async () => {
    h.prisma.product.findUnique.mockResolvedValue({ ...PRODUCT, unitsPerBox: 6 });
    h.prisma.product.findFirst.mockResolvedValue({ ...PRODUCT, unitsPerBox: 6 });
    h.prisma.changeRequest.findUnique.mockResolvedValue(
      addItem({ qty: 1, boxes: null, pieces: null }, "CUSTOMER"),
    );
    mergeInto({
      id: "li-1",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: 40,
      subtotal: 80,
      status: "PENDING",
      deliveredQty: 0,
    });

    const body = await conflictCode(
      h.service.approveChangeRequestAtStop("cr-1", operatorPayload as never, null),
    );

    expect(body.code).toBe("MERGE_PACK_MISMATCH");
    expect(body.message).toMatch(/12/);
    expect(body.message).toMatch(/6/);
    expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
    expect(h.prisma.deliveryMutation.create).not.toHaveBeenCalled();
  });

  it("SA-841 R5: 5 loose pieces into a box-unaware line of 1 box are refused 409, nothing written (SA-104a)", async () => {
    h.prisma.changeRequest.findUnique.mockResolvedValue(addItem({ qty: 5, boxes: 0, pieces: 5 }));
    mergeInto({
      id: "li-1",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 1,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 40,
      subtotal: 40,
      status: "PENDING",
      deliveredQty: 0,
    });

    const body = await conflictCode(h.service.approveChangeRequestAtStop("cr-1", driver, null));

    expect(body.code).toBe("MERGE_PACK_MISMATCH");
    expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
    expect(h.prisma.deliveryMutation.create).not.toHaveBeenCalled();
  });

  it("SA-841 MUST-1: a NON-boxed driver add filed as {qty 5, boxes 0, pieces 0} adds 5 (10 + 5 = 15 at $8.50 = $127.50), never $0", async () => {
    const plain = { ...PRODUCT, name: "Sample Soap", unitsPerBox: null, pricePerUnit: 8.5 };
    h.prisma.product.findUnique.mockResolvedValue(plain);
    h.prisma.product.findFirst.mockResolvedValue(plain);
    h.prisma.changeRequest.findUnique.mockResolvedValue(addItem({ qty: 5, boxes: 0, pieces: 0 }));
    mergeInto({
      id: "li-1",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 10,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 8.5,
      subtotal: 85,
      status: "PENDING",
      deliveredQty: 0,
    });

    await h.service.approveChangeRequestAtStop("cr-1", driver, null);

    expect(h.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      data: expect.objectContaining({ qty: 15, boxes: null, pieces: null, subtotal: 127.5 }),
    });
    expect(h.prisma.deliveryMutation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderItemId: "li-1", qty: 5 }),
    });
  });

  it("SA-841 (b): a buyer's 1 box filed at the LIVE 6-pack into a 12-pack line is the 409 MERGE_PACK_MISMATCH, never a 400 split mismatch", async () => {
    h.prisma.product.findUnique.mockResolvedValue({ ...PRODUCT, unitsPerBox: 6 });
    h.prisma.product.findFirst.mockResolvedValue({ ...PRODUCT, unitsPerBox: 6 });
    h.prisma.changeRequest.findUnique.mockResolvedValue(
      addItem({ qty: 6, boxes: 1, pieces: 0 }, "CUSTOMER"),
    );
    mergeInto({
      id: "li-1",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: 40,
      subtotal: 80,
      status: "PENDING",
      deliveredQty: 0,
    });

    const body = await conflictCode(
      h.service.approveChangeRequestAtStop("cr-1", operatorPayload as never, null),
    );

    expect(body.code).toBe("MERGE_PACK_MISMATCH");
    expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
  });

  it("SA-841 (a) SA-124b: with a 6-pack line and a 12-pack line of the product, a driver's 12-pack box merges into the 12-pack line", async () => {
    const six = {
      id: "li-6",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 12,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 6,
      unitLabel: null,
      unitPrice: 20,
      subtotal: 40,
      status: "PENDING",
      deliveredQty: 0,
    };
    const twelve = { ...six, id: "li-12", qty: 24, unitsPerBox: 12, unitPrice: 40, subtotal: 80 };
    h.prisma.changeRequest.findUnique.mockResolvedValue(addItem({ qty: 12, boxes: 1, pieces: 0 }));
    h.prisma.order.findUnique.mockResolvedValue(order([six, twelve]));
    h.prisma.orderItem.findMany.mockResolvedValueOnce([]).mockResolvedValue([
      { ...six, trackedCategoryId: null },
      { ...twelve, trackedCategoryId: null },
    ]);
    h.prisma.orderItem.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => (where.id === "li-12" ? twelve : six),
    );

    await h.service.approveChangeRequestAtStop("cr-1", driver, null);

    expect(h.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-12" },
      data: expect.objectContaining({
        qty: 36,
        boxes: 3,
        pieces: 0,
        unitsPerBox: 12,
        subtotal: 120,
      }),
    });
  });
});
