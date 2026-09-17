/**
 * Feature grants v2 brief C (PR-5) — mirrors `apps/web/lib/feature-modes.ts` (mobile mirrors web
 * convention; duplicated rather than shared through a runtime package since this is a small,
 * pure UI selector, not a DTO/contract shape). Pure selector over a tenant's `modes` record (the
 * shape brief A's `TenantFeaturesResponse.modes` / `/tenants/me/features` hook will expose once
 * it lands — not on this base yet, only its schema + shared contract, commit f6985746).
 * Deliberately NOT wired into a screen yet — see the web file's header for why; the HARD
 * INVARIANT holds by construction because the operator route/trip screens this brief owns are
 * untouched.
 */

export interface RoutesDispatchVisibility {
  /** Show the "New route" (planned/scheduled) entry point. */
  showScheduledEntry: boolean;
  /** Show the "New trip" (ad-hoc) entry point. */
  showAdhocEntry: boolean;
}

const ROUTES_DISPATCH_KEY = "routes_dispatch";

/**
 * `modes` is the tenant's `TenantFeaturesResponse.modes` record (or `undefined`/`null` before
 * that data has loaded, or for a tenant with no config row — the common case today). A missing
 * or unrecognized value resolves the same as `"unset"`/`"mixed"`: show everything, matching
 * today's unrestricted behavior.
 */
export function getRoutesDispatchVisibility(
  modes?: Record<string, string> | null,
): RoutesDispatchVisibility {
  const mode = modes?.[ROUTES_DISPATCH_KEY] ?? "unset";
  if (mode === "scheduled") return { showScheduledEntry: true, showAdhocEntry: false };
  if (mode === "adhoc") return { showScheduledEntry: false, showAdhocEntry: true };
  return { showScheduledEntry: true, showAdhocEntry: true };
}
