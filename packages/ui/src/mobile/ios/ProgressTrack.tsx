import React from "react";
import { StyleSheet, View } from "react-native";
import { ios } from "../../tokens";

export interface ProgressTrackProps {
  /** 0–100. */
  percent: number;
  fill?: "brand" | "green" | "orange" | "red";
  /** Track height in px — default 4. */
  height?: number;
}

export function ProgressTrack({ percent, fill = "brand", height = 4 }: ProgressTrackProps) {
  const fillColor =
    fill === "green"
      ? ios.system.green
      : fill === "orange"
        ? ios.system.orange
        : fill === "red"
          ? ios.system.red
          : ios.brand;
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <View style={[styles.track, { height }]}>
      <View
        style={[
          styles.fill,
          { width: `${clamped}%`, backgroundColor: fillColor, height },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    backgroundColor: ios.gray[5],
    borderRadius: 999,
    overflow: "hidden",
  },
  fill: {
    borderRadius: 999,
  },
});
