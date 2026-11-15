import { Logger } from "@nestjs/common";
import { OperatorPermissionGroup } from "@prisma/client";
import { ALL_PERMISSION_GROUPS } from "./operator-permissions.service";
import { priceEditAllowedFor } from "./price-edit";
import { priceEditReported } from "./price-edit-answer";

/**
 * SA-1034 rule 10 / W-870: `GET /users/me/permissions` reports `priceEditAllowed`, the answer the web uses to enable
 * "Add custom item" (never a role). It enforces the deny list whatever the global permissions mode (which stays "shadow"
 * and is not an input), exactly as `priceEditAllowedFor` decides.
 */
describe("priceEditReported (the capability /me/permissions tells the web)", () => {
  const all = ALL_PERMISSION_GROUPS;
  const without = (g: OperatorPermissionGroup) => all.filter((x) => x !== g);

  it("an operator without PRICING is reported as not allowed; with it, allowed", () => {
    expect(priceEditReported("OPERATOR", without("PRICING"), all)).toBe(false);
    expect(priceEditReported("OPERATOR", [], all)).toBe(false);
    expect(priceEditReported("OPERATOR", all, all)).toBe(true);
    expect(priceEditReported("OPERATOR", without("FINANCE"), all)).toBe(true);
  });

  it("an account admin is allowed, whatever groups it holds", () => {
    expect(priceEditReported("TENANT_ADMIN", all, all)).toBe(true);
    expect(priceEditReported("TENANT_ADMIN", [], all)).toBe(true);
  });

  it("a platform super admin, a driver, a buyer and no role are never allowed", () => {
    for (const role of ["SUPER_ADMIN", "DRIVER", "CUSTOMER", null, undefined]) {
      expect(priceEditReported(role, all, all)).toBe(false);
    }
  });
});

/**
 * Parity (rule 10): what the web is TOLD (`priceEditReported`) is exactly what the server DECIDES
 * (`priceEditAllowedFor`), for every role and every denied set. The screen can never offer a control the server then
 * refuses, or hide one it would allow.
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
  beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("every role x denied set agrees", async () => {
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
        expect({ role, denied, reported: priceEditReported(role, held, all) }).toEqual({
          role,
          denied,
          reported: decided,
        });
        compared++;
      }
    }
    expect(compared).toBe(roles.length * deniedSets.length);
  });
});
