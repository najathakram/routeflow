import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { useNavigationContainerRef, useSegments } from "expo-router";
import { StackActions } from "@react-navigation/native";
import { IosTabBarView, type IosTabBarItem } from "@routeflow/ui/mobile/ios";
import { activeOperatorTab, visibleOperatorTabs, type OperatorTabKey } from "../lib/operator-tabs";
import { findDeepTabStackKey } from "../lib/operator-tab-nav";
import { useDeliveryAccess, useRoutesAccess } from "../lib/api/addons";

const META: Record<OperatorTabKey, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  home: { label: "Home", icon: "home-outline" },
  dispatch: { label: "Dispatch", icon: "car-outline" },
  orders: { label: "Orders", icon: "receipt-outline" },
  warehouse: { label: "Warehouse", icon: "business-outline" },
  more: { label: "More", icon: "ellipsis-horizontal" },
};

/**
 * The operator bottom nav, rendered once in `(operator)/_layout.tsx` as an
 * in-flow sibling of the `<Stack>` — so it stays put on all ~106 operator
 * screens, not just the 18 that live inside the `(tabs)` navigator.
 *
 * The tab navigator's own bar is switched off (`tabBar={() => null}`) so exactly
 * one bar exists. That also means `tabPress` never fires, so pop-to-root is
 * reimplemented here rather than as a listener.
 */
export function OperatorTabBar() {
  const segments = useSegments() as string[];
  const navRef = useNavigationContainerRef();
  const active = activeOperatorTab(segments);
  const routesAccess = useRoutesAccess();
  const deliveryAccess = useDeliveryAccess();
  // Owner split 2026-08-25: the Dispatch hub fronts BOTH recurring routes and
  // ad-hoc order delivery, so EITHER addon earns the tab (owner decision
  // 2026-08-28: each helper reads its feature addon alone — developer_mode no
  // longer folds in). Gating on developer_mode alone would hide the tab from a
  // tenant who bought only recurring_routes or only order_delivery, stranding
  // them with no way into (operator)/_layout.tsx's now-widened sections.
  //
  // Default-hidden while loading: both helpers report `enabled: false` until
  // the addons query resolves, so an entitled tenant must never see Dispatch
  // flash then vanish on cold start. It appears a moment late on first load
  // only — the addons query is cached afterwards.
  const tabs = visibleOperatorTabs(routesAccess.enabled || deliveryAccess.enabled);

  const go = (tab: OperatorTabKey) => {
    if (!navRef.isReady()) return;
    const rootState = navRef.getRootState();

    // 1. Pop-to-root for the DESTINATION tab's own nested stack. Targeted,
    //    because that navigator isn't focused when we're coming from elsewhere.
    const innerKey = findDeepTabStackKey(rootState, tab);
    if (innerKey) navRef.dispatch({ ...StackActions.popToTop(), target: innerKey });

    // 2. Unwind the (operator) stack back to (tabs) and select the tab, in one
    //    action. Dispatched UNTARGETED through the container ref so that an
    //    action a navigator can't serve keeps bubbling to one that can.
    //
    //    Verified in the browser from all four starting positions: a cold deep
    //    link with no (tabs) mounted, an off-tab screen, another tab, and the
    //    destination tab itself. The (operator) stack holds exactly one (tabs)
    //    route afterwards in every case.
    //
    //    Not the router helpers: expo-router dispatches at the deepest
    //    DIVERGING navigator with an explicit `target`. From an off-tab screen
    //    that is the (operator) Stack, where REPLACE inserts a SECOND (tabs)
    //    route and the stack grows every time the bar is used. From inside
    //    (tabs) it is the tab navigator, whose TabRouter implements neither
    //    REPLACE nor POP_TO — and a targeted action it can't serve is swallowed
    //    as "handled", so nothing happens at all.
    //
    //    `screen` is stripped from route info, so nothing leaks into the URL.
    navRef.dispatch(StackActions.popTo("(tabs)", { screen: tab }));
  };

  const items: IosTabBarItem[] = tabs.map((tab) => ({
    key: tab,
    label: META[tab].label,
    focused: active === tab,
    renderIcon: ({ color, size }) => <Ionicons name={META[tab].icon} size={size} color={color} />,
    onPress: () => go(tab),
  }));

  return <IosTabBarView items={items} />;
}
