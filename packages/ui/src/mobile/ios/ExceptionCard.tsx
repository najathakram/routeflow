import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "../../tokens";

export type ExceptionSeverity = "red" | "orange" | "yellow";

export interface ExceptionAction {
  label: string;
  onPress?: () => void;
}

export interface ExceptionCardProps {
  severity: ExceptionSeverity;
  title: string;
  subtitle?: string;
  timeLabel?: string;
  actions?: readonly ExceptionAction[];
  icon?: React.ReactNode;
}

const COLORS: Record<ExceptionSeverity, { bg: string; border: string; ink: string }> = {
  red: { bg: ios.system.redWash, border: ios.system.red, ink: ios.system.redInk },
  orange: { bg: ios.system.orangeWash, border: ios.system.orange, ink: ios.system.orangeInk },
  yellow: { bg: ios.system.yellowWash, border: ios.system.yellow, ink: ios.system.yellowInk },
};

export function ExceptionCard({
  severity,
  title,
  subtitle,
  timeLabel,
  actions,
  icon,
}: ExceptionCardProps) {
  const c = COLORS[severity];
  return (
    <View style={[styles.card, { borderLeftColor: c.border }]}>
      <View style={styles.headRow}>
        <View style={[styles.icon, { backgroundColor: c.bg }]}>
          {icon ?? <Text style={[styles.iconText, { color: c.ink }]}>!</Text>}
        </View>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.sub} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {timeLabel ? <Text style={styles.time}>{timeLabel}</Text> : null}
      </View>
      {actions && actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((a, i) => (
            <Pressable
              key={a.label}
              onPress={a.onPress}
              style={[styles.actionBtn, i === 0 ? styles.actionPrimary : styles.actionSecondary]}
            >
              <Text
                style={[styles.actionText, i === 0 ? styles.actionTextOn : styles.actionTextOff]}
              >
                {a.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    borderLeftWidth: 3,
    overflow: "hidden",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  text: { flex: 1, minWidth: 0 },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  sub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  time: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  actions: {
    flexDirection: "row",
    gap: 6,
    marginTop: 10,
    paddingLeft: 40,
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  actionPrimary: { backgroundColor: ios.brand },
  actionSecondary: { backgroundColor: ios.fill3 },
  actionText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  actionTextOn: { color: "#fff" },
  actionTextOff: { color: ios.label },
});
