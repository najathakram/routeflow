import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "../../tokens";
import { Pill } from "./Pill";

export type StopStatus = "done" | "next" | "pending";

export interface StopCardProps {
  number: number;
  name: string;
  subtitle: string;
  status: StopStatus;
  pillLabel?: string;
  onPress?: () => void;
}

const STATUS_COLORS: Record<StopStatus, string> = {
  done: ios.system.green,
  next: ios.brand,
  pending: ios.gray[4],
};

export function StopCard({ number, name, subtitle, status, pillLabel, onPress }: StopCardProps) {
  const accent = STATUS_COLORS[status];
  const badgeBg = status === "pending" ? ios.fill3 : accent;
  const badgeFg = status === "pending" ? ios.label : "#fff";
  const pillVariant = status === "done" ? "green" : status === "next" ? "brand" : "orange";

  const inner = (
    <View style={[styles.card, { borderLeftColor: accent }]}>
      <View style={styles.row}>
        <View style={[styles.numBadge, { backgroundColor: badgeBg }]}>
          <Text style={[styles.numText, { color: badgeFg }]}>{number}</Text>
        </View>
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {pillLabel ? (
          <Pill variant={pillVariant}>{pillLabel}</Pill>
        ) : (
          <Text style={styles.chev}>›</Text>
        )}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} android_ripple={{ color: ios.fill3 }}>
        {inner}
      </Pressable>
    );
  }
  return inner;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    borderLeftWidth: 3,
    overflow: "hidden",
  },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  numBadge: {
    width: 26,
    height: 26,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  numText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  text: { flex: 1, minWidth: 0 },
  name: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  sub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
  },
  chev: {
    fontSize: 22,
    color: ios.gray[3],
    fontFamily: "Inter_400Regular",
  },
});
