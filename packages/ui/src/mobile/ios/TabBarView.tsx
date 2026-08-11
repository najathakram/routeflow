import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ios } from "../../tokens";
import { Blur } from "./Blur";

export interface IosTabBarItem {
  /** Stable React key. */
  key: string;
  label: string;
  focused: boolean;
  /**
   * Receives the already-resolved tint so a caller can't drift from the
   * active/inactive colours.
   */
  renderIcon: (p: { focused: boolean; color: string; size: number }) => React.ReactNode;
  onPress: () => void;
}

/**
 * The iOS bottom bar's LOOK, with no navigation knowledge at all.
 *
 * Split out of `IosTabBar` so two callers can share one visual implementation:
 * the React Navigation adapter (`IosTabBar`, used by driver/customer/tenant) and
 * the operator's persistent bar, which lives outside the tab navigator entirely
 * and derives its own state from the route segments. Keeping the chrome here is
 * what stops those two drifting apart.
 *
 * `@routeflow/ui` deliberately takes no router dependency — hence `items[]`
 * rather than navigator props.
 */
export function IosTabBarView({ items }: { items: readonly IosTabBarItem[] }) {
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, 8);

  return (
    <Blur intensity={80} tint="light" style={[styles.wrap, { paddingBottom: bottomPad }]}>
      <View style={styles.inner}>
        {items.map((item) => {
          const color = item.focused ? ios.brand : ios.gray[1];
          return (
            <Pressable
              key={item.key}
              onPress={item.onPress}
              style={styles.tab}
              accessibilityRole="button"
              accessibilityState={item.focused ? { selected: true } : {}}
            >
              <View style={styles.icon}>
                {item.renderIcon({ focused: item.focused, color, size: 25 })}
              </View>
              <Text style={[styles.label, { color }]} numberOfLines={1}>
                {item.label}
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
