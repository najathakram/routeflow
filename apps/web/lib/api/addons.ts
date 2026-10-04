import {
  DEVELOPER_MODE_ADDON,
  ORDER_DELIVERY_ADDON,
  RECURRING_ROUTES_ADDON,
} from "@routeflow/types";
import { useTenantAddons } from "./tobacco";
import { useTenantFeatures } from "../tenant-features";

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

// ─── scan_v2 (accumulating create-order scan screen) ──────────────────────────
//
// Fleet ruling 2026-09-19: no new plan flags while the feature registry is frozen, so the new scan
// screen rides the `developer_mode` addon — already owner-grantable per tenant, dark by default
// (`enabled` is false until the addons fetch succeeds AND lists it, so loading, an error and an
// ungranted tenant all read OFF). One line to swap when a real flag exists; call sites use this
// hook, never `useDeveloperMode` directly, so that swap touches only here.
export function useScanV2(): boolean {
  return useDeveloperMode().enabled;
}

// ─── Order UI v2 (card-list order detail — LANE-S / order-ui-redesign) ────────
//
// Dark until the owner flips it. Gated on the existing in-development surface flag
// (`developer_mode`) behind ONE indirection, so promoting it to a real per-tenant plan flag
// later is a one-line change here and not a hunt through call sites. Read through this hook
// only — never `useDeveloperMode()` directly at an order-UI call site.
export function useOrderUiV2(): { enabled: boolean; resolved: boolean } {
  const dev = useDeveloperMode();
  return { enabled: dev.enabled, resolved: dev.resolved };
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
 *  in-development surfaces — today that is the order-detail card list, see `useOrderUiV2`). */
export function useDeliveryAccess(): { enabled: boolean; resolved: boolean } {
  const od = useOrderDelivery();
  return { enabled: od.enabled, resolved: od.resolved };
}

export function useRoutesAccess(): { enabled: boolean; resolved: boolean } {
  const rr = useRecurringRoutes();
  return { enabled: rr.enabled, resolved: rr.resolved };
}

// ─── Fleet (any dispatch feature at all) ──────────────────────────────────────
//
// A tenant is FLEET-OFF when it holds neither recurring_routes nor order_delivery: it ships by carrier
// only, so the route / driver / delivery-run surfaces are noise (fleet-off clean UI). Fleet-ON tenants
// see exactly the UI they always did. FAILS OPEN: while the addons fetch is loading or errored
// (`resolved` false) `fleet` is true, so a tenant is never shown a stripped-down UI on an unknown answer
// (the same rule RouteGuard uses). Display-only: never a server gate.
export function useFleetAccess(): { fleet: boolean; loading: boolean } {
  // The server's own answer wins when present: `capabilities.fulfilment.fleet`.
  const features = useTenantFeatures().data as
    { capabilities?: { fulfilment?: { fleet?: boolean } } } | undefined;
  const serverFleet = features?.capabilities?.fulfilment?.fleet;
  const routes = useRoutesAccess();
  const delivery = useDeliveryAccess();
  const resolved = routes.resolved && delivery.resolved;
  if (typeof serverFleet === "boolean") return { fleet: serverFleet, loading: false };
  return { fleet: !resolved || routes.enabled || delivery.enabled, loading: !resolved };
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

// ─── Inline returns (Returns Inside Order Creation, "orders_inline_returns") ──
//
// Read with `useHasAddon(ORDERS_INLINE_RETURNS_ADDON)` (lib/api/tobacco.ts) to gate the
// "Record return" entry points (order detail, customer detail — RecordInlineReturnDialog).
// UX gate only — every /returns/inline/* route independently 403s via AddonGuard
// (`returns.controller.ts`'s `@RequireAddon("orders_inline_returns")`), registered
// ENFORCED from day one (feature-registry.ts), so a stale/missing addons fetch here just
// hides the entry point — it never lets a capture through the gate.
export const ORDERS_INLINE_RETURNS_ADDON = "orders_inline_returns";
