import "reflect-metadata";
import { CustomersController } from "./customers.controller";

/** B1018 / SA-642: the PATCH handler hands the caller to the service, so the credit-limit audit row names who changed it. */
describe("CustomersController.update forwards the actor (B1018)", () => {
  it("calls customersService.update(id, dto, undefined, user)", () => {
    const controller = Object.create(CustomersController.prototype) as any;
    controller.customersService = { update: jest.fn().mockReturnValue("ok") };
    const user = { sub: "user-1", tenantId: "tenant-1" };
    const dto = { creditLimit: null };
    expect(controller.update("c1", dto, user)).toBe("ok");
    expect(controller.customersService.update).toHaveBeenCalledWith("c1", dto, undefined, user);
  });
});
