import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CustomerOrderSuggestionsController } from "./customer-order-suggestions.controller";

describe("CustomerOrderSuggestionsController", () => {
  const reflector = new Reflector();
  const handler = CustomerOrderSuggestionsController.prototype.getSuggestions;

  it("is staff-only: OPERATOR (TENANT_ADMIN passes the hierarchy); never DRIVER or CUSTOMER", () => {
    const roles = reflector.get<UserRole[]>(ROLES_KEY, handler);
    expect(roles).toEqual([UserRole.OPERATOR]);
    expect(roles).not.toContain(UserRole.DRIVER);
    expect(roles).not.toContain(UserRole.CUSTOMER);
  });

  it("refuses DRIVER and CUSTOMER and admits OPERATOR and TENANT_ADMIN through the RolesGuard", () => {
    const guard = new RolesGuard(reflector);
    const ctx = (role: UserRole) =>
      ({
        getHandler: () => handler,
        getClass: () => CustomerOrderSuggestionsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as any;
    const allowed = (role: UserRole) => {
      try {
        return guard.canActivate(ctx(role)) === true;
      } catch {
        return false;
      }
    };
    expect(allowed(UserRole.OPERATOR)).toBe(true);
    expect(allowed(UserRole.TENANT_ADMIN)).toBe(true);
    expect(allowed(UserRole.DRIVER)).toBe(false);
    expect(allowed(UserRole.CUSTOMER)).toBe(false);
  });

  it("serves GET customers/:customerId/order-suggestions", () => {
    expect(Reflect.getMetadata("path", CustomerOrderSuggestionsController)).toBe("customers");
    expect(Reflect.getMetadata("path", handler)).toBe(":customerId/order-suggestions");
  });

  it("passes the customer id to the service", async () => {
    const service = { getSuggestions: jest.fn().mockResolvedValue({ usuallyBuys: [] }) };
    const controller = new CustomerOrderSuggestionsController(service as any);
    expect(await controller.getSuggestions("c1")).toEqual({ usuallyBuys: [] });
    expect(service.getSuggestions).toHaveBeenCalledWith("c1");
  });
});
