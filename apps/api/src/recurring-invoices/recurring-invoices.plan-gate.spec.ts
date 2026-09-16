import "reflect-metadata";
import { RecurringInvoicesController } from "./recurring-invoices.controller";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";

/**
 * WP5a (R3b.3, R3b.5): class-level JwtAuthGuard + RolesGuard + PlanFlagGuard and
 * @RequirePlanFlag("flag.recurring_invoices") on RecurringInvoicesController.
 * flag.recurring_invoices ships dark (DARK_PLAN_FLAGS in plan-flag-policy.ts), so
 * this is a structural/metadata contract check.
 */
describe("RecurringInvoicesController — plan gate (WP5a)", () => {
  it("sits behind JwtAuthGuard + RolesGuard + PlanFlagGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", RecurringInvoicesController) ?? []) as Array<{
      name: string;
    }>;
    const guardNames = guards.map((g) => g.name);
    expect(guardNames).toEqual(
      expect.arrayContaining(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]),
    );
  });

  it("carries @RequirePlanFlag('flag.recurring_invoices') at the class level", () => {
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, RecurringInvoicesController)).toBe(
      "flag.recurring_invoices",
    );
  });

  it("keeps @Roles(OPERATOR) at the class level", () => {
    expect(Reflect.getMetadata(ROLES_KEY, RecurringInvoicesController)).toEqual([
      UserRole.OPERATOR,
    ]);
  });

  it.each(["create", "findAll", "findOne", "update", "deactivate", "activate", "runNow"])(
    "handler %s still exists on the controller",
    (handlerName) => {
      expect(
        typeof (RecurringInvoicesController.prototype as unknown as Record<string, unknown>)[
          handlerName
        ],
      ).toBe("function");
    },
  );
});
