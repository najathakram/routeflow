import { DEVELOPER_MODE_ADDON } from "@routeflow/types";
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
