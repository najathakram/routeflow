import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * BO-07 (Q1): switching an order to PICKUP (POS mode) honours an OPERATOR's denied ORDERS group, read live
 * from the user row. TENANT_ADMIN never reads it; an OPERATOR with no row holds nothing (fail closed).
 */
describe("OrdersService.updateFulfillPath: POS mode and the operator's denied groups", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const operator = { ...operatorPayload, tenantId: "t-1" };

  const toPickup = (user: unknown) =>
    h.service.updateFulfillPath("ord-1", { fulfillPath: "PICKUP" } as any, user as any);
  const heldRow = (denied: string[]) =>
    h.prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: denied,
      permissionsVersion: 1,
    });

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      status: "CONFIRMED",
      routeRunStopId: null,
      routeRunStop: null,
    });
    h.prisma.order.update.mockImplementation((a: any) =>
      Promise.resolve({ id: "ord-1", ...a.data }),
    );
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it("an OPERATOR denied ORDERS is refused with POS_MODE_NOT_PERMITTED and nothing is written", async () => {
    heldRow(["ORDERS"]);
    await expect(toPickup(operator)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: "POS_MODE_NOT_PERMITTED" }),
    });
    expect(h.prisma.order.update).not.toHaveBeenCalled();
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("an OPERATOR denied only another group may switch", async () => {
    heldRow(["PRICING"]);
    await toPickup(operator);
    expect(h.prisma.order.update).toHaveBeenCalledTimes(1);
  });

  it("an OPERATOR with no user row is refused (fail closed)", async () => {
    h.prisma.user.findFirst.mockResolvedValue(null);
    await expect(toPickup(operator)).rejects.toMatchObject({ status: 403 });
  });

  it("a TENANT_ADMIN may switch and no permissions read is made", async () => {
    await toPickup({ ...operator, role: "TENANT_ADMIN" });
    expect(h.prisma.user.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.order.update).toHaveBeenCalledTimes(1);
  });

  it("a switch to another path does not read the operator's permissions", async () => {
    heldRow(["ORDERS"]);
    await h.service
      .updateFulfillPath("ord-1", { fulfillPath: "ROUTE" } as any, operator as any)
      .catch(() => undefined);
    expect(h.prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
