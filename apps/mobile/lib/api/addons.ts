import { useQuery } from "@tanstack/react-query";
import {
  DEVELOPER_MODE_ADDON,
  DRIVER_PAYMENTS_ADDON,
  ORDER_DELIVERY_ADDON,
  RECURRING_ROUTES_ADDON,
} from "@routeflow/types";
import { apiClient } from "../api-client";
import { useAuthStore } from "../auth-store";
import { useTenantStore } from "../tenant-store";

// ─── Developer mode (hidden dispatch/driver/route addon) ──────────────────────
//
// To un-hide everything at launch: grep useDeveloperMode and delete the gate
// conditions (or make this return { enabled: true, isLoading: false }).
//
// Mirrors apps/mobile/lib/api/tobacco.ts's useTenantAddons fetch pattern, but
// gated on auth state: pre-auth screens mount before a token exists, so the
// query must stay disabled (`enabled: isAuthenticated`) rather than fire and
// 401. With the query disabled, TanStack v5's `isPending` stays true forever —
// isLoading is only true while we're both authenticated AND actually pending,
// so a logged-out screen never reports "loading".
//
// The key is tenant-scoped (same shape as tobacco.ts, so the cache is still
// shared between the two hooks). The QueryClient is module-scoped in
// app/_layout.tsx and nothing clears it on logout, so a tenant-agnostic key
// would hand the next session the previous tenant's flags for the rest of the
// staleTime — signing out of a dev-mode tenant and straight into another one on
// the same device would unhide the whole dispatch surface there.
//
// `resolved` says whether the flag was actually READ (vs. the fetch failing and
// `enabled` defaulting to false). Any routing that can strand a user — the
// driver branch in app/_layout.tsx — must key off `resolved`, never off a bare
// `!enabled`, and fail OPEN when the answer is unknown. Unlike tobacco.ts this
// read is load-bearing, so it gets a retry budget instead of `retry: false`;
// only the first attempt reports `isLoading`, so retries heal the flag in the
// background without holding anyone behind a bootstrap spinner.
export function useDeveloperMode(): { enabled: boolean; isLoading: boolean; resolved: boolean } {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenantSlug = useTenantStore((s) => s.slug);

  const query = useQuery<{ addons: string[] }>({
    queryKey: ["tenant", tenantSlug, "addons"],
    queryFn: () => apiClient.get("/tenants/me/addons").then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });

  const enabled = query.data?.addons?.includes(DEVELOPER_MODE_ADDON) ?? false;
  const isLoading = isAuthenticated && query.isPending && query.failureCount === 0;
  return { enabled, isLoading, resolved: query.isSuccess };
}

// ─── Driver payments (per-tenant at-door collection opt-in) ───────────────────
//
// Owner decision 2026-08-24: collecting money at the door is opt-in per tenant
// (acme yes, acme-distribution no). Same query/cache as useDeveloperMode — one addons
// fetch serves both. Fail-CLOSED on `enabled` (unknown ⇒ no payment UI) but the
// at-door flow must key the "which completion endpoint" choice off `resolved`
// where it can strand a driver: when the flag is unknown, payment.tsx falls
// back to the plain complete endpoint, which every tenant may call.
export function useDriverPayments(): { enabled: boolean; isLoading: boolean; resolved: boolean } {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenantSlug = useTenantStore((s) => s.slug);

  const query = useQuery<{ addons: string[] }>({
    queryKey: ["tenant", tenantSlug, "addons"],
    queryFn: () => apiClient.get("/tenants/me/addons").then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });

  const enabled = query.data?.addons?.includes(DRIVER_PAYMENTS_ADDON) ?? false;
  const isLoading = isAuthenticated && query.isPending && query.failureCount === 0;
  return { enabled, isLoading, resolved: query.isSuccess };
}

// ─── Recurring routes (standing route templates + scheduled dispatch) ─────────
//
// Owner decision 2026-08-25: order delivery and recurring routes are separate
// per-tenant addons. Owner decision 2026-08-28: `developer_mode` no longer
// unlocks either — see useDeliveryAccess/useRoutesAccess below, which now read
// the feature addon alone; `developer_mode` remains only for genuinely
// in-development mobile surfaces (the (driver) app, role-picker's driver
// option, and the (tenant) dispatch tab). Same query/cache as
// useDeveloperMode and useDriverPayments — one addons fetch serves all three.
export function useRecurringRoutes(): { enabled: boolean; isLoading: boolean; resolved: boolean } {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenantSlug = useTenantStore((s) => s.slug);

  const query = useQuery<{ addons: string[] }>({
    queryKey: ["tenant", tenantSlug, "addons"],
    queryFn: () => apiClient.get("/tenants/me/addons").then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });

  const enabled = query.data?.addons?.includes(RECURRING_ROUTES_ADDON) ?? false;
  const isLoading = isAuthenticated && query.isPending && query.failureCount === 0;
  return { enabled, isLoading, resolved: query.isSuccess };
}

// ─── Order delivery (ad-hoc trips planned from selected orders) ───────────────
//
// See useRecurringRoutes above — same addons fetch, sibling feature.
export function useOrderDelivery(): { enabled: boolean; isLoading: boolean; resolved: boolean } {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenantSlug = useTenantStore((s) => s.slug);

  const query = useQuery<{ addons: string[] }>({
    queryKey: ["tenant", tenantSlug, "addons"],
    queryFn: () => apiClient.get("/tenants/me/addons").then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });

  const enabled = query.data?.addons?.includes(ORDER_DELIVERY_ADDON) ?? false;
  const isLoading = isAuthenticated && query.isPending && query.failureCount === 0;
  return { enabled, isLoading, resolved: query.isSuccess };
}

// ─── Composition helpers: effective surface visibility ────────────────────────
//
// Every routes/deliveries gate (section redirects, dispatch hub, orders Select
// action) should read through these, never through the raw addon hooks.

/** Order-delivery surface visibility — the feature addon alone (owner decision
 *  2026-08-28: developer_mode no longer unlocks GA delivery features; it
 *  remains only for genuinely in-development surfaces, none of which are
 *  order-delivery). */
export function useDeliveryAccess(): { enabled: boolean; resolved: boolean } {
  const od = useOrderDelivery();
  return { enabled: od.enabled, resolved: od.resolved };
}

/** Recurring-routes surface visibility — the feature addon alone (see
 *  useDeliveryAccess above for the 2026-08-28 decision). */
export function useRoutesAccess(): { enabled: boolean; resolved: boolean } {
  const rr = useRecurringRoutes();
  return { enabled: rr.enabled, resolved: rr.resolved };
}
