import { OperatorPermissionGroup } from "@prisma/client";
import { ALL_PERMISSION_GROUPS } from "./operator-permissions.service";
import { priceEditReported } from "./price-edit-answer";

/**
 * SA-1034 rule 10: `GET /users/me/permissions` reports `priceEditAllowed`, the MODE-APPLIED answer the web uses to
 * enable "Add custom item" (never a role). `live` enforces the deny list; `shadow` reports the role only, exactly as
 * `priceEditAllowedFor` decides in each mode.
 */
describe("priceEditReported (the capability /me/permissions tells the web)", () => {
  const all = ALL_PERMISSION_GROUPS;
  const without = (g: OperatorPermissionGroup) => all.filter((x) => x !== g);

  it("shadow: the role alone decides, so an operator with PRICING off is still reported as allowed", () => {
    expect(priceEditReported("OPERATOR", without("PRICING"), all, "shadow")).toBe(true);
    expect(priceEditReported("OPERATOR", [], all, "shadow")).toBe(true);
  });

  it("live: an operator without PRICING is reported as not allowed; with it, allowed", () => {
    expect(priceEditReported("OPERATOR", without("PRICING"), all, "live")).toBe(false);
    expect(priceEditReported("OPERATOR", all, all, "live")).toBe(true);
    expect(priceEditReported("OPERATOR", without("FINANCE"), all, "live")).toBe(true);
  });

  it("an account admin is allowed in both modes, whatever groups it holds", () => {
    expect(priceEditReported("TENANT_ADMIN", all, all, "live")).toBe(true);
    expect(priceEditReported("TENANT_ADMIN", [], all, "live")).toBe(true);
    expect(priceEditReported("TENANT_ADMIN", all, all, "shadow")).toBe(true);
  });

  it("a platform super admin, a driver, a buyer and no role are never allowed", () => {
    for (const role of ["SUPER_ADMIN", "DRIVER", "CUSTOMER", null, undefined]) {
      expect(priceEditReported(role, all, all, "shadow")).toBe(false);
      expect(priceEditReported(role, all, all, "live")).toBe(false);
    }
  });
});
