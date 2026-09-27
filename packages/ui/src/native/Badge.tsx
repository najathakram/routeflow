import * as React from "react";
import { Text, View, type ViewProps } from "react-native";
import { resolveStatusTone, type BadgeStatus, type BadgeVariant } from "../status-tones";
import { resolveBadgeStyle } from "./badge-style";

export interface BadgeProps extends Omit<ViewProps, "children"> {
  variant?: BadgeVariant;
  status?: BadgeStatus;
  label?: string;
}

/** Native kit Badge (#2332): web `Badge`, fed by the same shared status → tone map. */
export function Badge({ variant, status, label, style, ...props }: BadgeProps) {
  const t = resolveStatusTone({ status, variant, label });
  const s = resolveBadgeStyle(t.variant);
  return (
    <View accessibilityRole="text" style={[s.container, style]} {...props}>
      <View style={s.dot} />
      <Text style={s.label} numberOfLines={1}>
        {t.label}
      </Text>
    </View>
  );
}
