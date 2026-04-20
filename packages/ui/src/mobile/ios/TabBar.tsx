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
        tabBarLabel?: string | ((props: { focused: boolean; color: string; position?: unknown; children?: string }) => React.ReactNode);
        tabBarIcon?: (props: { focused: boolean; color: string; size: number }) => React.ReactNode;
      };
    }
  >;
  navigation: {
    emit: (e: { type: "tabPress"; target: string; canPreventDefault: boolean }) => { defaultPrevented: boolean };
    navigate: (name: never) => void;
  };
};

/**
 * iOS-style bottom tab bar for use with Expo Router's <Tabs tabBar={...}/>.
 * Uses a blurred translucent background with brand-tinted active icons.
 */
export function IosTabBar({ state, descriptors, navigation }: IosTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, 8);

  return (
    <Blur intensity={80} tint="light" style={[styles.wrap, { paddingBottom: bottomPad }]}>
      <View style={styles.inner}>
        {state.routes.map((route, index) => {
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
