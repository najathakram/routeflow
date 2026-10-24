import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { OrdersController } from "./orders.controller";

describe("OrdersController batch-ship / packing-slips (#3168)", () => {
  const roles = (fn: unknown) => new Reflector().get<string[]>(ROLES_KEY, fn as never);
  it.each(["batchShip", "packingSlips"] as const)("%s is OPERATOR + TENANT_ADMIN only", (m) => {
    expect([...roles(OrdersController.prototype[m])].sort()).toEqual(["OPERATOR", "TENANT_ADMIN"]);
  });
  it("delegates to the services", async () => {
    const batch = { batchShip: jest.fn(async () => ({ results: [] })) };
    const slips = { generate: jest.fn(async () => ({ url: null, included: [], skipped: [] })) };
    const c = new OrdersController({} as any, {} as any, batch as any, slips as any);
    const user = { sub: "u" } as any;
    await c.batchShip({ orders: [{ orderId: "a", carrier: "UPS" }] } as any, user);
    expect(batch.batchShip).toHaveBeenCalledWith(
      [{ orderId: "a", carrier: "UPS", trackingNumber: undefined }],
      user,
    );
    await c.packingSlips({ orderIds: ["a"] } as any);
    expect(slips.generate).toHaveBeenCalledWith(["a"]);
  });
});
