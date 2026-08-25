import { useQuery } from "@tanstack/react-query";
import { DEVELOPER_MODE_ADDON, DRIVER_PAYMENTS_ADDON } from "@routeflow/types";
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
// (affa yes, bb-distro no). Same query/cache as useDeveloperMode — one addons
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
