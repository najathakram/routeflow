import React from "react";
import { IosTabBarView, type IosTabBarItem } from "./TabBarView";

// Minimal structural subset of @react-navigation/bottom-tabs' `BottomTabBarProps`.
// Declared inline so `@routeflow/ui` doesn't need a direct dependency on
// @react-navigation/bottom-tabs — the consumer (apps/mobile) supplies the real
// props via Expo Router's <Tabs tabBar={...}/>.
type IosTabBarProps = {
  state: { index: number; routes: ReadonlyArray<{ key: string; name: string }> };
  descriptors: Record<
    string,
    {
      options: {
        title?: string;
        tabBarLabel?:
          | string
          | ((props: {
              focused: boolean;
              color: string;
              position?: unknown;
              children?: string;
            }) => React.ReactNode);
        tabBarIcon?: (props: { focused: boolean; color: string; size: number }) => React.ReactNode;
        // Expo Router sets `tabBarButton: () => null` when a screen has `href: null`.
        // The default @react-navigation tabs filter on that; we replicate here.
        tabBarButton?: unknown;
        tabBarItemStyle?: { display?: "none" | "flex" } | unknown;
        href?: string | null;
      };
    }
  >;
  navigation: {
    emit: (e: { type: "tabPress"; target: string; canPreventDefault: boolean }) => {
      defaultPrevented: boolean;
    };
    navigate: (name: never) => void;
  };
};

function shouldRenderTab(options: IosTabBarProps["descriptors"][string]["options"]): boolean {
  // Hide screens explicitly marked as non-tab (href: null) — Expo Router
  // translates those to either tabBarButton === null or display: "none".
  if (options.tabBarButton === null) return false;
  if (options.href === null) return false;
  const style = options.tabBarItemStyle as { display?: string } | undefined;
  if (style && style.display === "none") return false;
  // Require an explicit icon so ad-hoc / nested routes don't sneak in.
  if (!options.tabBarIcon) return false;
  return true;
}

/**
 * iOS-style bottom tab bar for use with Expo Router's <Tabs tabBar={...}/>.
 *
 * This is the React Navigation ADAPTER: it turns navigator state into the plain
 * item list `IosTabBarView` renders. All the chrome lives there, shared with the
 * operator's persistent bar. Used by driver / customer / tenant.
 */
export function IosTabBar({ state, descriptors, navigation }: IosTabBarProps) {
  const items: IosTabBarItem[] = state.routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => shouldRenderTab(descriptors[route.key]!.options))
    .map(({ route, index }) => {
      const { options } = descriptors[route.key]!;
      const isFocused = state.index === index;
      return {
        key: route.key,
        label:
          typeof options.tabBarLabel === "string"
            ? options.tabBarLabel
            : (options.title ?? route.name),
        focused: isFocused,
        // shouldRenderTab already guarantees tabBarIcon exists.
        renderIcon: (p) => options.tabBarIcon!(p),
        onPress: () => {
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (!isFocused && !event.defaultPrevented) navigation.navigate(route.name as never);
        },
      };
    });

  return <IosTabBarView items={items} />;
}
