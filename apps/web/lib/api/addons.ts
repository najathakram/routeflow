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
