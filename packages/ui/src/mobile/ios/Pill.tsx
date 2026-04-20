import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { ios } from "../../tokens";

export type PillVariant =
  | "brand"
  | "green"
  | "orange"
  | "red"
  | "gray"
  | "yellow"
  | "purple";

export interface PillProps {
  variant?: PillVariant;
  dot?: boolean;
  children: React.ReactNode;
  /** Compact — 11px font, tighter padding. Used for inline tags. */
  small?: boolean;
}

const VARIANT_COLORS: Record<PillVariant, { bg: string; text: string }> = {
  brand: { bg: ios.brandWash, text: ios.brand },
  green: { bg: ios.system.greenWash, text: ios.system.greenInk },
  orange: { bg: ios.system.orangeWash, text: ios.system.orangeInk },
  red: { bg: ios.system.redWash, text: ios.system.redInk },
  gray: { bg: ios.fill3, text: "#636366" },
  yellow: { bg: ios.system.yellowWash, text: ios.system.yellowInk },
  purple: { bg: ios.system.purpleWash, text: ios.system.purpleInk },
};

export function Pill({ variant = "gray", dot = false, small = false, children }: PillProps) {
  const c = VARIANT_COLORS[variant];
  return (
    <View
      style={[
        styles.pill,
        small && styles.pillSmall,
        { backgroundColor: c.bg },
      ]}
    >
      {dot ? <View style={[styles.dot, { backgroundColor: c.text }]} /> : null}
      <Text style={[styles.label, small && styles.labelSmall, { color: c.text }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  pillSmall: {
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.1,
  },
  labelSmall: {
    fontSize: 11,
  },
});
