import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ios } from "../../tokens";
import { Blur } from "./Blur";

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
 * Uses a blurred translucent background with brand-tinted active icons.
 */
export function IosTabBar({ state, descriptors, navigation }: IosTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, 8);

  const visibleRoutes = state.routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => shouldRenderTab(descriptors[route.key]!.options));

  return (
    <Blur intensity={80} tint="light" style={[styles.wrap, { paddingBottom: bottomPad }]}>
      <View style={styles.inner}>
        {visibleRoutes.map(({ route, index }) => {
          const { options } = descriptors[route.key]!;
          const label =
            typeof options.tabBarLabel === "string"
              ? options.tabBarLabel
              : (options.title ?? route.name);
          const isFocused = state.index === index;
          const color = isFocused ? ios.brand : ios.gray[1];

          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) navigation.navigate(route.name as never);
          };

          const icon = options.tabBarIcon
            ? options.tabBarIcon({ focused: isFocused, color, size: 25 })
            : null;

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              style={styles.tab}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
            >
              <View style={styles.icon}>{icon}</View>
              <Text style={[styles.label, { color }]} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Blur>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    // Match mockup tab bar: no shadow, just the hairline
    ...Platform.select({
      android: { elevation: 0 },
      default: {},
    }),
  },
  inner: {
    flexDirection: "row",
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: 2,
  },
  icon: {
    width: 28,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.1,
  },
});
