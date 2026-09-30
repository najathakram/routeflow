import "reflect-metadata";
import { CreditNotesController } from "./credit-notes.controller";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";

/**
 * WP5b (R3b.3, R3b.5): class-level JwtAuthGuard + PlanFlagGuard and
 * @RequirePlanFlag("flag.credit_notes") on CreditNotesController — RolesGuard stays
 * per-handler (it was never at the class level here), NOT moved up. flag.credit_notes
 * ships dark (DARK_PLAN_FLAGS in plan-flag-policy.ts).
 */
describe("CreditNotesController — plan gate (WP5b)", () => {
  it("sits behind JwtAuthGuard + PlanFlagGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", CreditNotesController) ?? []) as Array<{
      name: string;
    }>;
    const guardNames = guards.map((g) => g.name);
    expect(guardNames).toEqual(expect.arrayContaining(["JwtAuthGuard", "PlanFlagGuard"]));
  });

  it("carries @RequirePlanFlag('flag.credit_notes') at the class level", () => {
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, CreditNotesController)).toBe(
      "flag.credit_notes",
    );
  });

  it("does NOT carry a class-level @Roles — RolesGuard/@Roles stay per-handler", () => {
    expect(Reflect.getMetadata(ROLES_KEY, CreditNotesController)).toBeUndefined();
  });

  // create/apply/void/unapply/update each still carry their own RolesGuard + @Roles.
  // void/unapply name TENANT_ADMIN explicitly too (#2403 / SA-436 PR-3).
  it.each([
    ["create", [UserRole.OPERATOR]],
    ["apply", [UserRole.OPERATOR]],
    ["voidNote", [UserRole.OPERATOR, UserRole.TENANT_ADMIN]],
    ["unapply", [UserRole.OPERATOR, UserRole.TENANT_ADMIN]],
    ["update", [UserRole.OPERATOR]],
  ] as const)("handler %s keeps its own RolesGuard + @Roles(%j)", (handlerName, roles) => {
    const handler = (CreditNotesController.prototype as unknown as Record<string, unknown>)[
      handlerName
    ];
    expect(typeof handler).toBe("function");
    const handlerGuards = (Reflect.getMetadata("__guards__", handler as object) ?? []) as Array<{
      name: string;
    }>;
    expect(handlerGuards.map((g) => g.name)).toContain("RolesGuard");
    expect(Reflect.getMetadata(ROLES_KEY, handler as object)).toEqual([...roles]);
  });

  // findAll/findOne remain readable by any authenticated (customer-portal-aware)
  // role — no per-handler RolesGuard was ever added to them.
  it.each(["findAll", "findOne"])("handler %s carries no per-handler RolesGuard", (handlerName) => {
    const handler = (CreditNotesController.prototype as unknown as Record<string, unknown>)[
      handlerName
    ];
    const handlerGuards = (Reflect.getMetadata("__guards__", handler as object) ?? []) as Array<{
      name: string;
    }>;
    expect(handlerGuards.map((g) => g.name)).not.toContain("RolesGuard");
  });
});
