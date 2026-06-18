import React from "react";
import { StyleSheet, Text, View, Pressable } from "react-native";
import { ios } from "../../tokens";
import { Blur } from "./Blur";

export interface NavBarProps {
  /** Large 34px title rendered below the inline row. Omit for inline-only nav. */
  largeTitle?: string;
  /** Optional subtitle rendered under the large title. */
  subtitle?: string;
  /** Small centred title shown on the inline row (used when largeTitle is absent). */
  inlineTitle?: string;
  /** Left slot — usually a back button or an empty spacer. */
  leading?: React.ReactNode;
  /** Right slot — action button(s). */
  trailing?: React.ReactNode;
  /** Remove the blur + hairline border; used on tinted/transparent screens. */
  transparent?: boolean;
  /** Background tint — "light" over light canvas, "dark" over dark canvas. */
  tint?: "light" | "dark";
}

export function NavBar({
  largeTitle,
  subtitle,
  inlineTitle,
  leading,
  trailing,
  transparent = false,
  tint = "light",
}: NavBarProps) {
  const inner = (
    <View style={[styles.padding, !largeTitle && styles.inlineOnly]}>
      <View style={styles.inlineRow}>
        <View style={styles.slot}>{leading}</View>
        <Text style={styles.inlineTitle} numberOfLines={1}>
          {inlineTitle ?? ""}
        </Text>
        <View style={[styles.slot, styles.trailing]}>{trailing}</View>
      </View>
      {largeTitle ? (
        <Text style={styles.largeTitle} numberOfLines={1}>
          {largeTitle}
        </Text>
      ) : null}
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );

  if (transparent) {
    return <View style={styles.transparent}>{inner}</View>;
  }
  return (
    <Blur intensity={70} tint={tint} style={styles.blurWrap}>
      {inner}
    </Blur>
  );
}

/** Reusable "< Back" leading button. */
export function NavBackButton({
  label = "Back",
  onPress,
}: {
  label?: string;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.backBtn} hitSlop={8}>
      <Text style={styles.backChevron}>‹</Text>
      <Text style={styles.backLabel}>{label}</Text>
    </Pressable>
  );
}

/** Reusable right-side action (tappable text button). */
export function NavAction({
  label,
  onPress,
  bold = false,
}: {
  label: string;
  onPress?: () => void;
  bold?: boolean;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={[styles.action, bold && styles.actionBold]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  blurWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  transparent: {
    backgroundColor: "transparent",
  },
  padding: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  inlineOnly: {
    paddingBottom: 6,
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
    paddingBottom: 6,
  },
  slot: {
    minWidth: 48,
    flexDirection: "row",
    alignItems: "center",
  },
  trailing: {
    justifyContent: "flex-end",
  },
  inlineTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    flex: 1,
    textAlign: "center",
  },
  largeTitle: {
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: 0.35,
    lineHeight: 40,
    paddingTop: 4,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  backChevron: {
    fontSize: 28,
    color: ios.brand,
    lineHeight: 28,
    marginTop: -2,
  },
  backLabel: {
    fontSize: 17,
    color: ios.brand,
    fontFamily: "Inter_400Regular",
  },
  action: {
    fontSize: 17,
    color: ios.brand,
    fontFamily: "Inter_400Regular",
  },
  actionBold: {
    fontFamily: "Inter_600SemiBold",
  },
});
