import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { ios } from "../../tokens";

export interface KpiCardProps {
  icon?: React.ReactNode;
  iconBg?: string;
  value: string;
  label: string;
  /** Sub-line — e.g. "↑ 12 vs yesterday" or "3 need substitution". */
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
}

export function KpiCard({ icon, iconBg, value, label, delta, deltaTone = "neutral" }: KpiCardProps) {
  return (
    <View style={styles.card}>
      {icon !== undefined ? (
        <View style={[styles.iconWrap, iconBg ? { backgroundColor: iconBg } : null]}>{icon}</View>
      ) : null}
      <Text style={styles.value} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {delta ? (
        <Text
          style={[
            styles.delta,
            deltaTone === "up" && { color: ios.system.greenInk },
            deltaTone === "down" && { color: ios.system.redInk },
            deltaTone === "neutral" && { color: ios.gray[1] },
          ]}
          numberOfLines={1}
        >
          {delta}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: ios.bgElev,
    borderRadius: ios.cardRadius,
    padding: 14,
    minHeight: 110,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  value: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.6,
    lineHeight: 28,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 4,
  },
  delta: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    marginTop: 6,
  },
});
