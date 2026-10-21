import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * F3: one incoming edit array must not name the same stored line twice. updateOrderItems is the single
 * service entry behind PATCH /orders/:id/items (staff, driver, customer principal) and PATCH
 * /buyer/orders/:id/items, so one call here covers every order edit route. The refusal is a payload-only
 * 400 DUPLICATE_LINE_ID raised before ANY read or write.
 */
const driverPayload = { ...operatorPayload, sub: "user-drv", role: "DRIVER" as const };

describe("updateOrderItems: a duplicate line id is refused before anything is read or written", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  beforeEach(async () => {
    h = await buildOrdersService();
  });

  const nothingTouched = () => {
    expect(h.prisma.order.findUnique).not.toHaveBeenCalled();
    for (const m of ["create", "createMany", "update", "updateMany", "delete", "deleteMany"]) {
      expect((h.prisma.orderItem as any)[m]).not.toHaveBeenCalled();
    }
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  };
  const refused = (p: Promise<unknown>) =>
    expect(p).rejects.toMatchObject({ status: 400, response: { code: "DUPLICATE_LINE_ID" } });

  const dupStaff = [
    { id: "L1", qty: 1 },
    { id: "L1", qty: 19 },
  ];

  it.each([
    ["staff incremental", operatorPayload, false],
    ["staff replace-all", operatorPayload, true],
    ["driver", driverPayload, false],
  ])("%s: the same id twice is 400 DUPLICATE_LINE_ID, nothing touched", async (_n, user, rep) => {
    await refused(
      h.service.updateOrderItems(
        "ord-1",
        { items: dupStaff, ...(rep ? { replaceAll: true } : {}) } as never,
        user as never,
      ),
    );
    nothingTouched();
  });

  it("customer principal / buyer route (orderItemId): the same id twice is refused", async () => {
    await refused(
      h.service.updateOrderItems(
        "ord-1",
        {
          items: [
            { orderItemId: "L1", productId: "p1", qty: 1 },
            { orderItemId: "L1", productId: "p1", qty: 19 },
          ],
        } as never,
        customerPayload as never,
        { buyerLineIds: true },
      ),
    );
    nothingTouched();
  });

  it("control: distinct ids and several id-less new lines are NOT duplicates (planning proceeds)", async () => {
    // Past the guard the unconfigured mock order is a 404: proof the guard let the payload through.
    await expect(
      h.service.updateOrderItems(
        "ord-1",
        {
          items: [
            { id: "L1", qty: 1 },
            { id: "L2", qty: 2 },
            { productId: "p9", qty: 1 },
            { productId: "p9", qty: 3 },
          ],
        } as never,
        operatorPayload as never,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.order.findUnique).toHaveBeenCalled();
  });
});
