import { Logger } from "@nestjs/common";
import { OperatorPermissionGroup } from "@prisma/client";
import { ALL_PERMISSION_GROUPS, OperatorPermissionsService } from "./operator-permissions.service";
import { priceEditAllowedFor } from "./price-edit";
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

/**
 * Parity (rule 10): what the web is TOLD (`priceEditReported`) is exactly what the server DECIDES
 * (`priceEditAllowedFor`), for every role, every denied set and both modes. The screen can never offer a control the
 * server then refuses, or hide one it would allow.
 */
describe("priceEditReported == priceEditAllowedFor", () => {
  const all = ALL_PERMISSION_GROUPS;
  const roles = ["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN", "DRIVER", "CUSTOMER", null, undefined];
  const deniedSets: OperatorPermissionGroup[][] = [
    [],
    ...all.map((g) => [g]),
    all.filter((g) => g !== OperatorPermissionGroup.PRICING),
    [...all],
  ];
  let mode: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    mode = jest.spyOn(OperatorPermissionsService.prototype, "mode");
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(["shadow", "live"] as const)("%s: every role x denied set agrees", async (m) => {
    mode.mockReturnValue(m);
    let compared = 0;
    for (const role of roles) {
      for (const denied of deniedSets) {
        const prisma = {
          user: {
            findFirst: async () => ({ deniedPermissionGroups: denied, permissionsVersion: 1 }),
          },
        } as never;
        const held = all.filter((g) => !denied.includes(g));
        const decided = await priceEditAllowedFor(
          prisma,
          { sub: "u1", tenantId: "t1", role: role as never },
          "parity",
        );
        expect({ role, denied, m, reported: priceEditReported(role, held, all, m) }).toEqual({
          role,
          denied,
          m,
          reported: decided,
        });
        compared++;
      }
    }
    expect(compared).toBe(roles.length * deniedSets.length);
  });
});
