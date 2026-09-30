/**
 * Feature grants v2 brief C (PR-5) — pure selectors over a tenant's `modes` record (the shape
 * brief A's `TenantFeaturesResponse.modes` / `/tenants/me/features` hook will expose, once that
 * lands — see `packages/types/api/features.ts`). Deliberately data-in/data-out and NOT wired
 * into a page yet: brief A's authority/resolver + `/tenants/me/features` endpoint are not on
 * this base (only its schema + shared contract, commit f6985746) — the routes pages this brief
 * owns (`apps/web/app/(dashboard)/routes/**`) are left untouched so the HARD INVARIANT ("unset"
 * before == after) holds trivially, by construction, rather than by re-testing an unwired call
 * site. Once A's hook exists, a page calls `getRoutesDispatchVisibility(hookResult?.modes)` and
 * branches on the result — see feature-modes.test.ts for the exact contract every mode value
 * resolves to.
 */

export interface RoutesDispatchVisibility {
  /** Show the "Create Route" / planned-route entry points. */
  showScheduledEntry: boolean;
  /** Show the ad-hoc trip/dispatch entry points. */
  showAdhocEntry: boolean;
}

const ROUTES_DISPATCH_KEY = "routes_dispatch";

/**
 * `modes` is the tenant's `TenantFeaturesResponse.modes` record (or `undefined`/`null` before
 * that data has loaded, or for a tenant with no config row at all — the common case today).
 * A missing/unrecognized value resolves the same as `"unset"`/`"mixed"`: show everything,
 * matching today's unrestricted behavior — never narrower on an unrecognized mode string.
 */
export function getRoutesDispatchVisibility(
  modes?: Record<string, string> | null,
): RoutesDispatchVisibility {
  const mode = modes?.[ROUTES_DISPATCH_KEY] ?? "unset";
  if (mode === "scheduled") return { showScheduledEntry: true, showAdhocEntry: false };
  if (mode === "adhoc") return { showScheduledEntry: false, showAdhocEntry: true };
  return { showScheduledEntry: true, showAdhocEntry: true };
}
