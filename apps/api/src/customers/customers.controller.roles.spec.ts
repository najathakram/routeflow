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

  // T7 (REG-B132): upsertCustomerPrice admitted UserRole.DRIVER while its DELETE
  // sibling never did — the POST route let a driver null out a negotiated MSRP
  // override. The DELETE decorator (untouched by this batch) is the reference.
  it("REG-B132 upsertCustomerPrice declares the same roles as deleteCustomerPrice and admits no DRIVER", () => {
    const proto = CustomersController.prototype as Record<string, any>;
    expect(typeof proto.upsertCustomerPrice).toBe("function");
    expect(typeof proto.deleteCustomerPrice).toBe("function");
    const post = reflector.get<UserRole[]>(ROLES_KEY, proto.upsertCustomerPrice);
    const del = reflector.get<UserRole[]>(ROLES_KEY, proto.deleteCustomerPrice);
    expect(Array.isArray(post) && post.length > 0).toBe(true);
    expect(post).not.toContain(UserRole.DRIVER);
    expect([...post].sort()).toEqual([...del].sort());
  });
});
