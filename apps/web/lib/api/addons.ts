import {
  DEVELOPER_MODE_ADDON,
  ORDER_DELIVERY_ADDON,
  RECURRING_ROUTES_ADDON,
} from "@routeflow/types";
import { useTenantAddons } from "./tobacco";

// ─── Developer mode (hidden dispatch/driver/route addon) ──────────────────────
//
// To un-hide everything at launch: grep useDeveloperMode and delete the gate
// conditions (or make this return { enabled: true, isLoading: false, resolved: true }).
//
// `resolved` says whether the flag was actually READ (vs. the fetch failing and
// `enabled` defaulting to false — useTenantAddons uses retry: false, so a single
// 5xx leaves enabled=false AND isLoading=false). Any gate that can strand a user
// — the RouteGuard redirect in app/(dashboard)/layout.tsx — must key off
// `resolved`, never off a bare `!enabled`, and fail OPEN when the answer is
// unknown. Hiding-only gates (nav, shortcuts, cards) may use `enabled` directly.
export function useDeveloperMode(): { enabled: boolean; isLoading: boolean; resolved: boolean } {
  const { data, isLoading, isSuccess } = useTenantAddons();
  const enabled = data?.addons?.includes(DEVELOPER_MODE_ADDON) ?? false;
  return { enabled, isLoading, resolved: isSuccess };
}

// ─── Recurring routes (standing route templates + scheduled dispatch) ─────────
//
// Owner decision 2026-08-25: order delivery and recurring routes are separate
// per-tenant addons (see useDeliveryAccess/useRoutesAccess below — every gate
// should read through those, not this hook directly). Owner decision
// 2026-08-28: `developer_mode` no longer unlocks either GA delivery feature —
// see the composition-helpers comment below. Same addons fetch as
// useDeveloperMode — one call serves every flag.
export function useRecurringRoutes(): { enabled: boolean; isLoading: boolean; resolved: boolean } {
  const { data, isLoading, isSuccess } = useTenantAddons();
  const enabled = data?.addons?.includes(RECURRING_ROUTES_ADDON) ?? false;
  return { enabled, isLoading, resolved: isSuccess };
}

// ─── Order delivery (ad-hoc trips planned from selected orders) ───────────────
//
// See useRecurringRoutes above — same addons fetch, sibling feature.
export function useOrderDelivery(): { enabled: boolean; isLoading: boolean; resolved: boolean } {
  const { data, isLoading, isSuccess } = useTenantAddons();
  const enabled = data?.addons?.includes(ORDER_DELIVERY_ADDON) ?? false;
  return { enabled, isLoading, resolved: isSuccess };
}

// ─── Composition helpers: effective surface visibility ────────────────────────
//
// Every routes/deliveries gate (nav, RouteGuard, command palette, orders
// bulkbar) should read through these, never through the raw addon hooks.

/** Order-delivery surface visibility — the feature addon alone (owner decision 2026-08-28:
 *  developer_mode no longer unlocks GA delivery features; it remains only for genuinely
 *  in-development surfaces, none of which exist on web today). */
export function useDeliveryAccess(): { enabled: boolean; resolved: boolean } {
  const od = useOrderDelivery();
  return { enabled: od.enabled, resolved: od.resolved };
}

export function useRoutesAccess(): { enabled: boolean; resolved: boolean } {
  const rr = useRecurringRoutes();
  return { enabled: rr.enabled, resolved: rr.resolved };
}

// ─── MSRP on invoices (display-only suggested retail price) ───────────────────
//
// Naming precedent: TOBACCO_ADDON in apps/web/lib/api/tobacco.ts. Read with
// `useHasAddon(MSRP_ADDON)` (also exported from tobacco.ts) to gate MSRP inputs —
// the server independently re-checks flag.msrp on every write, so this is a UX
// gate only, never the source of truth.
export const MSRP_ADDON = "msrp";

// ─── Sales agents & commissions (flag.sales_agents) ───────────────────────
//
// Read with `useHasAddon(SALES_AGENTS_ADDON)` (lib/api/tobacco.ts) to gate the
// sales-agents / commissions surfaces. UX gate only — every /sales-agents and
// /commission-statements route independently 403s via PlanFlagGuard.
export const SALES_AGENTS_ADDON = "sales_agents";
