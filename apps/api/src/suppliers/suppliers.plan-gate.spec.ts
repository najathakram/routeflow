import "reflect-metadata";
import { SuppliersController } from "./suppliers.controller";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";

/**
 * WP5b (R3b.3, R3b.5): class-level JwtAuthGuard + RolesGuard + PlanFlagGuard and
 * @RequirePlanFlag("flag.suppliers") on SuppliersController. flag.suppliers ships
 * dark (DARK_PLAN_FLAGS in plan-flag-policy.ts).
 */
describe("SuppliersController — plan gate (WP5b)", () => {
  it("sits behind JwtAuthGuard + RolesGuard + PlanFlagGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", SuppliersController) ?? []) as Array<{
      name: string;
    }>;
    const guardNames = guards.map((g) => g.name);
    expect(guardNames).toEqual(
      expect.arrayContaining(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]),
    );
  });

  it("carries @RequirePlanFlag('flag.suppliers') at the class level", () => {
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, SuppliersController)).toBe("flag.suppliers");
  });

  it.each(["findAll", "findOne", "create", "update", "deactivate", "remove"])(
    "handler %s still carries @Roles(OPERATOR)",
    (handlerName) => {
      const handler = (SuppliersController.prototype as Record<string, unknown>)[handlerName];
      expect(typeof handler).toBe("function");
      expect(Reflect.getMetadata(ROLES_KEY, handler as object)).toEqual([UserRole.OPERATOR]);
    },
  );
});
