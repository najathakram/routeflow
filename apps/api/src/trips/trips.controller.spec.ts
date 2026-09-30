/**
 * Security tests for the trips module.
 *
 * WP4: GET /trips/eligibility and POST /trips are both OPERATOR-only. Also
 * re-pins that this module doesn't disturb the tight @Throttle on the
 * existing template-optimize endpoint that the trip builder calls right
 * after POST /trips succeeds (best-effort optimize, WP8).
 */
import "reflect-metadata";
import { TripsController } from "./trips.controller";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { RouteTemplateOptimizationController } from "../route-optimization/route-optimization.controller";

describe("TripsController — access control", () => {
  it("sits behind JwtAuthGuard + RolesGuard, OPERATOR-only", () => {
    const guards = (Reflect.getMetadata("__guards__", TripsController) ?? []) as Array<{
      name: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(
      expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]),
    );
    expect(Reflect.getMetadata(ROLES_KEY, TripsController)).toEqual([UserRole.OPERATOR]);
  });

  it("both handlers (GET eligibility, POST) are reachable under that single class-level gate", () => {
    const handlers = Object.getOwnPropertyNames(TripsController.prototype).filter(
      (n) => n !== "constructor",
    );
    expect(handlers).toEqual(expect.arrayContaining(["getEligibility", "createTrip"]));
    // Neither handler carries its own conflicting/overriding @Roles — the
    // class-level OPERATOR gate is the single source of truth for both.
    for (const handler of handlers) {
      expect(
        Reflect.getMetadata(ROLES_KEY, (TripsController.prototype as any)[handler]),
      ).toBeUndefined();
    }
  });
});

describe("optimize endpoint throttle — untouched by the trips module", () => {
  const LIMIT_KEY = "THROTTLER:LIMITdefault";
  const TTL_KEY = "THROTTLER:TTLdefault";

  it("POST /routes/:id/optimize (called by the trip builder post-create) keeps its tight @Throttle(10 / 60s)", () => {
    expect(
      Reflect.getMetadata(LIMIT_KEY, RouteTemplateOptimizationController.prototype.optimize),
    ).toBe(10);
    expect(
      Reflect.getMetadata(TTL_KEY, RouteTemplateOptimizationController.prototype.optimize),
    ).toBe(60_000);
  });
});
