import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OperatorPermissionGroup, UserRole } from "@prisma/client";
import { UnitsController } from "../../units/units.controller";
import { OperatorPermissionsService } from "../permissions/operator-permissions.service";
import { RolesGuard } from "./roles.guard";

/**
 * SA-977 on the REAL controller: `UnitsController` carries class-level `@RequirePermission("CATALOG")` and the unit list is a
 * method-level `@PermissionBase`. A method-level base marker beats the class groups, so an operator WITHOUT Catalog still
 * reads the unit list (shadow: no would-deny; live: no 403) while the other unit handlers stay Catalog-only.
 */
describe("RolesGuard: the unit list is base inside a Catalog class (SA-977)", () => {
  const ctx = (method: keyof UnitsController): ExecutionContext =>
    ({
      getHandler: () => UnitsController.prototype[method],
      getClass: () => UnitsController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { sub: "op", tenantId: "t1", role: UserRole.OPERATOR } }),
      }),
    }) as unknown as ExecutionContext;

  const guardFor = (mode: "shadow" | "live", held: OperatorPermissionGroup[]) => {
    const hasAny = jest.fn(async (_u: unknown, groups: string[]) =>
      groups.some((g) => (held as string[]).includes(g)),
    );
    const perms = { mode: () => mode, hasAny } as unknown as OperatorPermissionsService;
    return { guard: new RolesGuard(new Reflector(), perms), hasAny };
  };

  it("an operator with Orders but NOT Catalog is allowed on the unit list, with no permission lookup at all", () => {
    for (const mode of ["shadow", "live"] as const) {
      const { guard, hasAny } = guardFor(mode, ["ORDERS"]);
      expect(guard.canActivate(ctx("list"))).toBe(true); // synchronous true: nothing was looked up
      expect(hasAny).not.toHaveBeenCalled();
    }
  });

  it("the same operator is still refused (live) on a Catalog handler of the class", async () => {
    const { guard } = guardFor("live", ["ORDERS"]);
    await expect(Promise.resolve(guard.canActivate(ctx("create")))).rejects.toMatchObject({
      status: 403,
    });
  });
});
