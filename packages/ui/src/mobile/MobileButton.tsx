import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { colors, borderRadius } from "../tokens";

export type ButtonVariant = "primary" | "secondary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface MobileButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  children: React.ReactNode;
  style?: ViewStyle;
}

const VARIANT_STYLES = {
  primary: {
    container: {
      backgroundColor: colors.brand[500],
      borderWidth: 0,
    },
    text: { color: "#fff" },
    spinner: "#fff",
  },
  secondary: {
    container: {
      backgroundColor: "#fff",
      borderWidth: 1,
      borderColor: colors.surface.border,
    },
    text: { color: colors.navy.DEFAULT },
    spinner: colors.navy.DEFAULT,
  },
  danger: {
    container: {
      backgroundColor: colors.danger.DEFAULT,
      borderWidth: 0,
    },
    text: { color: "#fff" },
    spinner: "#fff",
  },
} as const;

const SIZE_STYLES = {
  sm: {
    container: { paddingHorizontal: 12, paddingVertical: 6, minHeight: 32 },
    text: { fontSize: 13 },
    spinnerSize: 14,
  },
  md: {
    container: { paddingHorizontal: 16, paddingVertical: 10, minHeight: 40 },
    text: { fontSize: 14 },
    spinnerSize: 16,
  },
  lg: {
    container: { paddingHorizontal: 20, paddingVertical: 14, minHeight: 56 },
    text: { fontSize: 16 },
    spinnerSize: 18,
  },
} as const;

export function MobileButton({
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  onPress,
  children,
  style,
}: MobileButtonProps) {
  const variantStyle = VARIANT_STYLES[variant];
  const sizeStyle = SIZE_STYLES[size];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        variantStyle.container,
        sizeStyle.container,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
    >
      {loading ? (
        <ActivityIndicator size={sizeStyle.spinnerSize} color={variantStyle.spinner} />
      ) : (
        <Text style={[styles.text, variantStyle.text, sizeStyle.text]}>{children}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: borderRadius.DEFAULT,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  text: {
    fontFamily: "Inter_600SemiBold",
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.85,
  },
});
