import { ConflictException } from "@nestjs/common";
import { RouteKind } from "@prisma/client";
import { allowedRouteKindsForMode, assertRouteKindDispatchAllowed } from "./route-dispatch-mode";

/**
 * Feature grants v2 brief C (PR-5), oracle 6 — mode x kind matrix. `scheduled` rejects ADHOC
 * (409 body {key, mode, allowed}) and accepts SCHEDULED; `adhoc` is the inverse; `mixed`/
 * `unset` accept both — the HARD INVARIANT case (every existing tenant resolves `unset` today).
 */
describe("route-dispatch-mode", () => {
  describe("scheduled", () => {
    it("accepts SCHEDULED", () => {
      expect(() => assertRouteKindDispatchAllowed("scheduled", RouteKind.SCHEDULED)).not.toThrow();
    });

    it("rejects ADHOC with a 409 body {key, mode, allowed}", () => {
      try {
        assertRouteKindDispatchAllowed("scheduled", RouteKind.ADHOC);
        throw new Error("expected assertRouteKindDispatchAllowed to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toEqual({
          code: "FEATURE_MODE",
          key: "routes_dispatch",
          mode: "scheduled",
          allowed: [RouteKind.SCHEDULED],
        });
      }
    });
  });

  describe("adhoc", () => {
    it("accepts ADHOC", () => {
      expect(() => assertRouteKindDispatchAllowed("adhoc", RouteKind.ADHOC)).not.toThrow();
    });

    it("rejects SCHEDULED with a 409 body {key, mode, allowed}", () => {
      try {
        assertRouteKindDispatchAllowed("adhoc", RouteKind.SCHEDULED);
        throw new Error("expected assertRouteKindDispatchAllowed to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toEqual({
          code: "FEATURE_MODE",
          key: "routes_dispatch",
          mode: "adhoc",
          allowed: [RouteKind.ADHOC],
        });
      }
    });
  });

  describe("mixed and unset accept both kinds (HARD INVARIANT: unset is every tenant's default today)", () => {
    it.each(["mixed", "unset"])("%s allows SCHEDULED and ADHOC", (mode) => {
      expect(() => assertRouteKindDispatchAllowed(mode, RouteKind.SCHEDULED)).not.toThrow();
      expect(() => assertRouteKindDispatchAllowed(mode, RouteKind.ADHOC)).not.toThrow();
      expect(allowedRouteKindsForMode(mode).sort()).toEqual(
        [RouteKind.ADHOC, RouteKind.SCHEDULED].sort(),
      );
    });
  });

  it("an unrecognized mode string fails OPEN (allows both) — FeatureConfigService.set() is where an unknown mode is rejected, not this runtime gate", () => {
    expect(allowedRouteKindsForMode("some_future_mode").sort()).toEqual(
      [RouteKind.ADHOC, RouteKind.SCHEDULED].sort(),
    );
  });
});
