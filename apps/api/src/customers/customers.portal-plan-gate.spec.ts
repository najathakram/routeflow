import "reflect-metadata";
import { CustomersController } from "./customers.controller";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";

/**
 * WP5c (R3b.3, R3b.4, R3b.9): handler-level PlanFlagGuard +
 * @RequirePlanFlag("addon.buyer_portal") on exactly the 7 buyer-portal-management
 * handlers of CustomersController — findAll and every other (non-portal) handler
 * stay untouched. addon.buyer_portal ships dark (DARK_PLAN_FLAGS in
 * plan-flag-policy.ts) and is also gated by the pre-existing flag.pricing_tiers
 * handlers (getCustomerPrices/upsertCustomerPrice/deleteCustomerPrice), which this
 * spec deliberately leaves alone.
 */
const PORTAL_HANDLERS = [
  "listPendingPortalApprovals",
  "sendPortalInvite",
  "resendPortalInvite",
  "disconnectPortal",
  "getPortalStatus",
  "approveBuyerRequest",
  "declineBuyerRequest",
];

// A representative sample of non-portal handlers that must NOT pick up the gate.
const NON_PORTAL_HANDLERS = [
  "findAll",
  "create",
  "exportCsv",
  "mergeCustomers",
  "findOne",
  "update",
  "getIncomeChart",
  "remove",
];

describe("CustomersController — buyer-portal plan gate (WP5c)", () => {
  it.each(PORTAL_HANDLERS)(
    "portal handler %s carries PlanFlagGuard + @RequirePlanFlag('addon.buyer_portal')",
    (handlerName) => {
      const handler = (CustomersController.prototype as Record<string, unknown>)[handlerName];
      expect(typeof handler).toBe("function");
      const handlerGuards = (Reflect.getMetadata("__guards__", handler as object) ?? []) as Array<{
        name: string;
      }>;
      expect(handlerGuards.map((g) => g.name)).toContain("PlanFlagGuard");
      expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, handler as object)).toBe(
        "addon.buyer_portal",
      );
    },
  );

  it("gates exactly those 7 handlers — no more, no fewer", () => {
    expect(PORTAL_HANDLERS).toHaveLength(7);
  });

  it.each(NON_PORTAL_HANDLERS)(
    "non-portal handler %s carries no addon.buyer_portal gate",
    (handlerName) => {
      const handler = (CustomersController.prototype as Record<string, unknown>)[handlerName];
      expect(typeof handler).toBe("function");
      expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, handler as object)).toBeUndefined();
    },
  );

  it("does not add a class-level @RequirePlanFlag to CustomersController", () => {
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, CustomersController)).toBeUndefined();
  });
});
