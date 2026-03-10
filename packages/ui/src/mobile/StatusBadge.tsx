import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, borderRadius } from "../tokens";

export type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

export type BadgeStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "SUSPENDED"
  | "PENDING"
  | "CONFIRMED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "COMPLETED";

const STATUS_MAP: Record<BadgeStatus, { variant: BadgeVariant; label: string }> = {
  ACTIVE: { variant: "success", label: "Active" },
  INACTIVE: { variant: "neutral", label: "Inactive" },
  SUSPENDED: { variant: "danger", label: "Suspended" },
  PENDING: { variant: "warning", label: "Pending" },
  CONFIRMED: { variant: "info", label: "Confirmed" },
  OUT_FOR_DELIVERY: { variant: "info", label: "Out for Delivery" },
  DELIVERED: { variant: "success", label: "Delivered" },
  CANCELLED: { variant: "danger", label: "Cancelled" },
  SCHEDULED: { variant: "neutral", label: "Scheduled" },
  IN_PROGRESS: { variant: "info", label: "In Progress" },
  COMPLETED: { variant: "success", label: "Completed" },
};

const VARIANT_COLORS: Record<BadgeVariant, { bg: string; text: string; dot: string }> = {
  success: {
    bg: colors.success.bg,
    text: colors.success.DEFAULT,
    dot: colors.success.DEFAULT,
  },
  warning: {
    bg: colors.warning.bg,
    text: colors.warning.DEFAULT,
    dot: colors.warning.DEFAULT,
  },
  danger: {
    bg: colors.danger.bg,
    text: colors.danger.DEFAULT,
    dot: colors.danger.DEFAULT,
  },
  info: {
    bg: colors.brand[100],
    text: colors.brand[700],
    dot: colors.brand[500],
  },
  neutral: {
    bg: colors.surface.raised,
    text: colors.navy.DEFAULT,
    dot: colors.surface.border,
  },
};

export interface StatusBadgeProps {
  variant?: BadgeVariant;
  status?: BadgeStatus;
  label?: string;
}

export function StatusBadge({ variant, status, label }: StatusBadgeProps) {
  const resolved = status ? STATUS_MAP[status] : null;
  const resolvedVariant = variant ?? resolved?.variant ?? "neutral";
  const resolvedLabel = label ?? resolved?.label ?? status ?? "";

  const c = VARIANT_COLORS[resolvedVariant];

  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <View style={[styles.dot, { backgroundColor: c.dot }]} />
      <Text style={[styles.text, { color: c.text }]}>{resolvedLabel}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  text: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
});