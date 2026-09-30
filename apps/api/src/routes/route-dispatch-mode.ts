import { ConflictException } from "@nestjs/common";
import { RouteKind } from "@prisma/client";

/**
 * Feature grants v2 brief C (PR-5). The `routes_dispatch` feature's effective config mode
 * gates which `Route.kind` a tenant may DISPATCH (start a run for) — never which kind exists
 * or was drafted; `RoutesService.createRun` is the one call site that both scheduled routes
 * (`POST /routes` + `POST /route-runs`) and ad-hoc trips (`TripsService.createTrip` drafts the
 * ADHOC route with zero order writes; dispatching it always goes through this same
 * `createRun`) funnel through — so gating here covers both entry points without editing
 * `apps/trips/**`, which brief C does not own.
 *
 * `"unset"` and `"mixed"` both allow every kind — the HARD INVARIANT (no tenant has a
 * `TenantFeatureConfig` row yet, so every tenant resolves `"unset"`) depends on this being a
 * strict superset of today's unrestricted behavior, not a narrower default.
 */
export const ROUTES_DISPATCH_KEY = "routes_dispatch";

export function allowedRouteKindsForMode(mode: string): RouteKind[] {
  switch (mode) {
    case "scheduled":
      return [RouteKind.SCHEDULED];
    case "adhoc":
      return [RouteKind.ADHOC];
    case "mixed":
    case "unset":
    default:
      // Default branch intentionally matches "unset"/"mixed": an unrecognized/future mode value
      // fails OPEN to "allow everything" here — the DENY decision belongs to
      // FeatureConfigService.set() (400 on an unknown mode), not to this runtime gate silently
      // narrowing dispatch for a mode string it doesn't recognize.
      return [RouteKind.SCHEDULED, RouteKind.ADHOC];
  }
}

/** Body shape matches the brief: 409 `FEATURE_MODE` `{ key, mode, allowed }`. */
export function assertRouteKindDispatchAllowed(effectiveMode: string, kind: RouteKind): void {
  const allowed = allowedRouteKindsForMode(effectiveMode);
  if (!allowed.includes(kind)) {
    throw new ConflictException({
      code: "FEATURE_MODE",
      key: ROUTES_DISPATCH_KEY,
      mode: effectiveMode,
      allowed,
    });
  }
}
