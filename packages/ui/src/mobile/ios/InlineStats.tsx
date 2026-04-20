import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { ios } from "../../tokens";

export interface InlineStat {
  value: string;
  label: string;
  /** Override the value color — e.g. brand teal for "Left" counts. */
  color?: string;
}

export interface InlineStatsProps {
  stats: readonly InlineStat[];
}

/** Multi-column stat strip divided by vertical hairlines. */
export function InlineStats({ stats }: InlineStatsProps) {
  return (
    <View style={styles.row}>
      {stats.map((s, i) => (
        <View key={`${s.label}-${i}`} style={[styles.cell, i > 0 && styles.cellDivider]}>
          <Text style={[styles.value, s.color ? { color: s.color } : null]} numberOfLines={1}>
            {s.value}
          </Text>
          <Text style={styles.label} numberOfLines={1}>
            {s.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    backgroundColor: ios.bgElev,
    borderRadius: ios.cardRadius,
    overflow: "hidden",
  },
  cell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  cellDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: ios.separator,
  },
  value: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.5,
  },
  label: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
    letterSpacing: 0.1,
  },
});
