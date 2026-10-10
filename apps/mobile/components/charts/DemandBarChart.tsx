import { StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import type { DemandBar } from "../../lib/demand-chart-logic";

/**
 * Dependency-free bar chart: one View per bucket with a proportional height.
 * Pure presentation — all series math lives in `lib/demand-chart-logic.ts`.
 */
export function DemandBarChart({
  bars,
  color,
  height = 140,
  summary,
}: {
  bars: readonly DemandBar[];
  color: string;
  height?: number;
  /** Screen-reader description of the whole chart (bars themselves are decorative). */
  summary: string;
}) {
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary}>
      <View style={[styles.plot, { height }]}>
        {bars.map((bar) => (
          <View key={bar.key} style={styles.col}>
            <View
              style={[
                styles.bar,
                { height: `${bar.heightPct}%`, backgroundColor: color },
                bar.heightPct === 0 && styles.zero,
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.axis}>
        {bars.map((bar) => (
          <View key={bar.key} style={styles.axisCell}>
            {bar.showAxis ? (
              <Text style={styles.axisText} numberOfLines={1}>
                {bar.axis}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plot: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  col: { flex: 1, height: "100%", justifyContent: "flex-end" },
  bar: { width: "100%", borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  zero: { height: 0 },
  axis: { flexDirection: "row", gap: 2, marginTop: 4 },
  // overflow visible so a label wider than its (narrow) bar column stays readable.
  axisCell: { flex: 1, alignItems: "center", overflow: "visible" },
  axisText: {
    fontSize: 9,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    width: 44,
    textAlign: "center",
  },
});
