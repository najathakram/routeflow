/**
 * Security test for the tenants module.
 *
 * developer_mode rollout: GET me/addons was OPERATOR-only. Pure DRIVER-role
 * users of a dev-mode tenant need to read this endpoint (the mobile
 * useDeveloperMode hook runs on driver screens), so the route was widened to
 * OPERATOR + DRIVER. Reflection-only (no DI) — mirrors
 * customers.security.spec.ts's pattern.
 */
import "reflect-metadata";
import { UserRole } from "@prisma/client";
import { TenantsController } from "./tenants.controller";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";

describe("TenantsController — me/addons role guard", () => {
  it("getMyAddons allows OPERATOR and DRIVER", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, TenantsController.prototype.getMyAddons);
    expect(roles).toEqual([UserRole.OPERATOR, UserRole.DRIVER]);
  });
});
