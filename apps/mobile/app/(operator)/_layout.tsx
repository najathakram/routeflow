import { Redirect, Stack, useSegments } from "expo-router";
import { View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { useSocket } from "../../hooks/useSocket";
import { OfflineBanner } from "../../components/OfflineBanner";
import { OperatorTabBar } from "../../components/OperatorTabBar";
import { useDeliveryAccess, useRoutesAccess } from "../../lib/api/addons";

// Owner split 2026-08-25: recurring routes and ad-hoc order delivery are two
// independent per-tenant addons (owner decision 2026-08-28: developer_mode no
// longer unlocks either — useRoutesAccess/useDeliveryAccess read the feature
// addon alone). Sections mirror lib/operator-tabs.ts SECTION_TO_TAB's
// "dispatch" entries, split by which feature actually owns each screen.
//
// "dispatch" itself is the shared hub ((tabs)/dispatch.tsx) that now surfaces
// BOTH the recurring-routes rows and the Order-delivery entry point, so it
// needs EITHER access rather than routes-only — the same reason drivers/
// driver (driver management, needed by both features) live in the EITHER
// set. Getting this wrong strands a delivery-only tenant on /home the moment
// they tap the widened Dispatch tab.
//
// "route-runs" is EITHER for the same reason: a run detail is the only screen
// a DISPATCHED delivery has — trips/new.tsx replaces straight to
// `route-runs/:id` the moment a dispatch succeeds.
const ROUTES_SECTIONS = new Set(["routes", "fleet"]);
const DELIVERY_SECTIONS = new Set(["trips"]);
const EITHER_SECTIONS = new Set(["dispatch", "drivers", "driver", "route-runs"]);
/**
 * The `routes/*` screens that are recurring-routes surfaces in their own right:
 * the list, plus new/create (create.tsx is an alias of new.tsx). Every DEEPER
 * `routes/:id…` screen is a detail page shared by BOTH features — an ad-hoc
 * delivery has no detail screen of its own, so trips/index.tsx opens every
 * delivery row at `routes/:id`. Gating those routes-only would bounce a
 * delivery-only tenant to /home from every delivery it opens. Mirrors web's
 * RECURRING_ROUTES_PATHS in apps/web/app/(dashboard)/layout.tsx.
 */
const RECURRING_ROUTES_SCREENS = new Set(["", "new", "create"]);

/** Which access a section (plus its first child screen) requires, if any. */
function sectionNeed(sec: string, screen: string): "routes" | "delivery" | "either" | null {
  if (sec === "routes") return RECURRING_ROUTES_SCREENS.has(screen) ? "routes" : "either";
  if (ROUTES_SECTIONS.has(sec)) return "routes";
  if (DELIVERY_SECTIONS.has(sec)) return "delivery";
  if (EITHER_SECTIONS.has(sec)) return "either";
  return null;
}

export default function OperatorLayout() {
  // RF-002: hoist Socket.IO subscription to layout level so real-time events
  // (order.created, order.statusChanged, route.stop.completed, etc.) keep
  // active queries fresh across every operator screen, not only the home tab.
  useSocket();
  const routesAccess = useRoutesAccess();
  const deliveryAccess = useDeliveryAccess();
  const segments = useSegments() as string[];

  // Single deep-link chokepoint for every dispatch/route/driver/fleet/trips
  // screen, instead of guarding ~15 individual screens. segments[0] is always
  // "(operator)" here; the tabs live one group deeper under "(tabs)".
  const section = segments[1] === "(tabs)" ? segments[2] : segments[1];
  const sec = section ?? "";
  // The screen one level below the section ("[id]", "new", …). Only the routes
  // section reads it, to tell its own list/form apart from the shared details.
  const screen = (segments[1] === "(tabs)" ? segments[3] : segments[2]) ?? "";
  const need = sectionNeed(sec, screen);

  // Fail OPEN when the addon read did not land (offline, timeout, API 5xx):
  // block only on a positively-resolved-and-denied flag, matching
  // app/_layout.tsx :178 and the pre-split single-flag discipline this
  // replaces. Both composed hooks read the same underlying tenant-addons
  // query, so resolved is effectively shared — OR'd defensively on "either" so
  // neither hook's resolution state can mask the other's.
  const resolved =
    need === "routes"
      ? routesAccess.resolved
      : need === "delivery"
        ? deliveryAccess.resolved
        : routesAccess.resolved || deliveryAccess.resolved;
  const enabled =
    need === "routes"
      ? routesAccess.enabled
      : need === "delivery"
        ? deliveryAccess.enabled
        : routesAccess.enabled || deliveryAccess.enabled;

  if (need !== null && resolved && !enabled) {
    return <Redirect href="/(operator)/home" />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: ios.bg }}>
      <OfflineBanner />
      {/* <Stack> carries flex:1 on both platforms, so the bar is a plain in-flow
          sibling below it — same shape as OfflineBanner above, and the same shape
          React Navigation's own BottomTabView uses. That means the screen viewport
          is simply shorter and NO screen needs bottom padding. It also means the
          bar survives every push, which is the whole point: only 18 of ~106
          operator screens live inside the (tabs) navigator, so a bar owned by that
          navigator vanishes on the other 88. */}
      <Stack screenOptions={{ headerShown: false }} />
      <OperatorTabBar />
    </View>
  );
}
