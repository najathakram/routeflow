import "reflect-metadata";
import { MessagesController } from "./messages.controller";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";

/**
 * WP5c (R3b.3, R3b.9): class-level JwtAuthGuard + PlanFlagGuard and
 * @RequirePlanFlag("flag.messaging") on MessagesController — the customer-facing
 * messaging transport. flag.messaging ships dark (DARK_PLAN_FLAGS in
 * plan-flag-policy.ts). notifications.controller.ts (operator device push) is a
 * DIFFERENT controller and is deliberately untouched — not asserted here.
 */
describe("MessagesController — plan gate (WP5c)", () => {
  it("sits behind JwtAuthGuard + PlanFlagGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", MessagesController) ?? []) as Array<{
      name: string;
    }>;
    const guardNames = guards.map((g) => g.name);
    expect(guardNames).toEqual(expect.arrayContaining(["JwtAuthGuard", "PlanFlagGuard"]));
  });

  it("carries @RequirePlanFlag('flag.messaging') at the class level", () => {
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, MessagesController)).toBe("flag.messaging");
  });

  it.each(["create", "findAll"])("handler %s still exists on the controller", (handlerName) => {
    expect(typeof (MessagesController.prototype as Record<string, unknown>)[handlerName]).toBe(
      "function",
    );
  });
});
