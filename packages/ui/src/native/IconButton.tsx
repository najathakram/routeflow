import * as React from "react";
import { Pressable, type PressableProps } from "react-native";
import { BUTTON_SIZES, resolveButtonStyle, slopFor, type ButtonSize } from "./button-style";
import { useTheme } from "./theme";

export interface IconButtonProps extends Omit<PressableProps, "children" | "style"> {
  /** Required: an icon has no visible text, so screen readers need a label. */
  accessibilityLabel: string;
  /** Render the icon in the given colour. */
  icon: (color: string) => React.ReactNode;
  variant?: "ghost" | "secondary" | "primary" | "danger";
  size?: ButtonSize;
}

/**
 * Native kit IconButton (#2331): a square button whose visual size matches the Button height and
 * whose touch area is always at least 44×44 (web `TAP_TARGET`).
 */
export function IconButton({
  icon,
  variant = "ghost",
  size = "md",
  disabled,
  ...props
}: IconButtonProps) {
  const theme = useTheme();
  const side = BUTTON_SIZES[size].height;
  const slop = slopFor(side);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={{ top: slop, bottom: slop, left: slop, right: slop }}
      style={({ pressed }) => {
        const s = resolveButtonStyle({ variant, size, pressed, disabled: !!disabled, theme });
        return [s.container, { width: side, paddingHorizontal: 0 }];
      }}
      {...props}
    >
      {({ pressed }) =>
        icon(resolveButtonStyle({ variant, size, pressed, disabled: !!disabled, theme }).foreground)
      }
    </Pressable>
  );
}
