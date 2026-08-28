import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { CustomersController } from "./customers.controller";

describe("CustomersController @Roles coverage", () => {
  const reflector = new Reflector();

  it("declares roles on findOrders (RolesGuard fails closed without them)", () => {
    const roles = reflector.get<UserRole[]>(ROLES_KEY, CustomersController.prototype.findOrders);
    expect(roles).toEqual(expect.arrayContaining([UserRole.OPERATOR, UserRole.CUSTOMER]));
  });

  it("every handler on the controller declares @Roles", () => {
    const proto = CustomersController.prototype as Record<string, any>;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== "constructor" && typeof proto[n] === "function",
    );
    for (const name of handlers) {
      const roles = reflector.get<UserRole[]>(ROLES_KEY, proto[name]);
      expect({ name, hasRoles: Array.isArray(roles) && roles.length > 0 }).toEqual({
        name,
        hasRoles: true,
      });
    }
  });
});
