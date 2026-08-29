/**
 * Pins the class-level @RequireAddon gate on the dispatch API surface (owner decision
 * 2026-08-28): /routes, /route-runs, /drivers, and route-optimization are SHARED between the
 * two delivery features (recurring routes + ad-hoc trips), so they accept EITHER feature addon;
 * /trips is the ad-hoc builder and is order_delivery-only. developer_mode is accepted
 * server-side on all five so a dev tenant can exercise the still-in-development mobile driver
 * app end-to-end — it no longer unlocks any GA client UI. A reflection test rather than an
 * e2e/HTTP test so it fails loudly (and cheaply) if the gate is ever accidentally removed.
 */
import "reflect-metadata";
import { RoutesController, RouteRunsController } from "./routes.controller";
import { TripsController } from "../trips/trips.controller";
import { DriversController } from "../drivers/drivers.controller";
import {
  RouteOptimizationController,
  RouteTemplateOptimizationController,
} from "../route-optimization/route-optimization.controller";
import { AddonGuard } from "../billing/addon.guard";
import { REQUIRE_ADDON_KEY } from "../billing/require-addon.decorator";

const EITHER_DELIVERY_ADDONS = ["recurring_routes", "order_delivery", "developer_mode"];

describe("dispatch API — class-level @RequireAddon gate", () => {
  it.each([
    ["RoutesController", RoutesController, EITHER_DELIVERY_ADDONS],
    ["RouteRunsController", RouteRunsController, EITHER_DELIVERY_ADDONS],
    ["DriversController", DriversController, EITHER_DELIVERY_ADDONS],
    ["RouteOptimizationController", RouteOptimizationController, EITHER_DELIVERY_ADDONS],
    [
      "RouteTemplateOptimizationController",
      RouteTemplateOptimizationController,
      EITHER_DELIVERY_ADDONS,
    ],
    ["TripsController", TripsController, ["order_delivery", "developer_mode"]],
  ])("%s carries the expected @RequireAddon key array", (_name, controller, expectedKeys) => {
    expect(Reflect.getMetadata(REQUIRE_ADDON_KEY, controller)).toEqual(expectedKeys);
  });

  it.each([
    ["RoutesController", RoutesController],
    ["RouteRunsController", RouteRunsController],
    ["DriversController", DriversController],
    ["RouteOptimizationController", RouteOptimizationController],
    ["RouteTemplateOptimizationController", RouteTemplateOptimizationController],
    ["TripsController", TripsController],
  ])("%s runs AddonGuard after JwtAuthGuard in @UseGuards", (_name, controller) => {
    const guards = (Reflect.getMetadata("__guards__", controller) ?? []) as Array<{
      name: string;
    }>;
    const guardNames = guards.map((g) => g.name);
    expect(guardNames).toContain("JwtAuthGuard");
    expect(guardNames).toContain(AddonGuard.name);
    expect(guardNames.indexOf(AddonGuard.name)).toBeGreaterThan(guardNames.indexOf("JwtAuthGuard"));
  });

  // PATCH /trips/routes/:routeId/planning is saved from the SHARED run-detail page
  // (/routes/:id), which a recurring-routes-only tenant can reach — so it must NOT inherit the
  // order_delivery-only class gate. Handler metadata wins in reflector.getAllAndOverride.
  it("TripsController.updatePlanning overrides the class gate with the either-gate", () => {
    expect(
      Reflect.getMetadata(REQUIRE_ADDON_KEY, TripsController.prototype.updatePlanning),
    ).toEqual(EITHER_DELIVERY_ADDONS);
  });
});
