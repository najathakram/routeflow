import * as React from "react";
import { ActivityIndicator, Pressable, Text, type PressableProps } from "react-native";
import { resolveButtonStyle, type ButtonSize, type ButtonVariant } from "./button-style";
import { useTheme } from "./theme";

export interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** Stretch to the parent's width (a common phone layout; web uses `w-full`). */
  fullWidth?: boolean;
}

/** Native kit Button (#2331): mirrors web `Button` variants and sizes. */
export function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  leftIcon,
  rightIcon,
  fullWidth,
  accessibilityState,
  ...props
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = !!disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ ...accessibilityState, disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      hitSlop={
        resolveButtonStyle({ variant, size, pressed: false, disabled: isDisabled, theme }).hitSlop
      }
      style={({ pressed }) => {
        const s = resolveButtonStyle({ variant, size, pressed, disabled: isDisabled, theme });
        return [s.container, fullWidth ? { alignSelf: "stretch" as const } : null];
      }}
      {...props}
    >
      {({ pressed }) => {
        const s = resolveButtonStyle({ variant, size, pressed, disabled: isDisabled, theme });
        return (
          <>
            {loading ? <ActivityIndicator size="small" color={s.foreground} /> : leftIcon}
            {typeof children === "string" || typeof children === "number" ? (
              <Text style={s.label} numberOfLines={1}>
                {children}
              </Text>
            ) : (
              children
            )}
            {!loading && rightIcon}
          </>
        );
      }}
    </Pressable>
  );
}
