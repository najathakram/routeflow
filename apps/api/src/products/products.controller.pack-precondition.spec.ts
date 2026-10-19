import { ProductsController } from "./products.controller";
import type { JwtPayload } from "../auth/jwt-payload.interface";

describe("PATCH /products/:id is the ONE client pack writer (SA-797a)", () => {
  it("passes packPrecondition 'client' and the User-Agent to ProductsService.update", async () => {
    const productsService = { update: jest.fn().mockResolvedValue({ id: "p1" }) };
    const c = new ProductsController(productsService as never, {} as never, {} as never);
    const user = { sub: "u1", username: "op" } as JwtPayload;
    await c.update("p1", { unitsPerBox: 6 } as never, user, "RouteFlow/412 CFNetwork");
    expect(productsService.update).toHaveBeenCalledWith(
      "p1",
      { unitsPerBox: 6 },
      expect.objectContaining({
        packPrecondition: "client",
        clientAgent: "RouteFlow/412 CFNetwork",
        actorId: "u1",
      }),
    );
  });
});
