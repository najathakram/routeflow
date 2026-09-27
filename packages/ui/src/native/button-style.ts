/**
 * Button styling for the native kit (#2331), mirroring `packages/ui/src/web/Button.tsx`. It is
 * pure, so the mobile jest suite can pin it without rendering React Native.
 *
 * The visual heights match web (sm 28 / md 34 / lg 40). The touch target reaches 44pt through
 * `hitSlop`, the native form of web's `TAP_TARGET`.
 */
import { ledgerInk, ledgerRadius, ledgerStatus, ledgerSurface } from "../tokens/ledger";
import { nativeFonts, nativeShadows } from "./tokens";
import type { NativeTheme } from "./theme";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

/** Minimum touch target in pt (web `TAP_TARGET`). */
export const MIN_TOUCH = 44;

export const BUTTON_SIZES: Record<
  ButtonSize,
  { height: number; paddingX: number; fontSize: number }
> = {
  sm: { height: 28, paddingX: 10, fontSize: 12.5 },
  md: { height: 34, paddingX: 14, fontSize: 13 },
  lg: { height: 40, paddingX: 18, fontSize: 14 },
};

export interface ButtonState {
  variant: ButtonVariant;
  size: ButtonSize;
  pressed: boolean;
  disabled: boolean;
  theme: NativeTheme;
}

export interface ResolvedButtonStyle {
  container: {
    height?: number;
    paddingHorizontal: number;
    borderRadius: number;
    backgroundColor: string;
    borderWidth: number;
    borderColor: string;
    opacity: number;
    flexDirection: "row";
    alignItems: "center";
    justifyContent: "center";
    gap: number;
  } & Partial<typeof nativeShadows.card>;
  label: {
    fontFamily: string;
    fontSize: number;
    color: string;
    textDecorationLine: "none" | "underline";
  };
  /** Colour for the loading spinner and any icon. */
  foreground: string;
  hitSlop: { top: number; bottom: number; left: number; right: number };
}

/** Extra touch area, per side, that lifts a control of `size` pt to the 44pt minimum. */
export function slopFor(size: number): number {
  return Math.max(0, Math.ceil((MIN_TOUCH - size) / 2));
}

const TRANSPARENT = "transparent";

function colours(
  variant: ButtonVariant,
  pressed: boolean,
  theme: NativeTheme,
): { bg: string; fg: string; border: string } {
  switch (variant) {
    case "primary":
      return {
        bg: pressed ? theme.accent.deep : theme.accent.strong,
        fg: theme.onAccent,
        border: TRANSPARENT,
      };
    case "secondary":
      return {
        bg: pressed ? ledgerSurface.canvas : ledgerSurface.paper,
        fg: ledgerInk[900],
        border: ledgerSurface.lineStrong,
      };
    case "ghost":
      return {
        bg: pressed ? ledgerSurface.sunken : TRANSPARENT,
        fg: pressed ? ledgerInk[900] : ledgerInk[500],
        border: TRANSPARENT,
      };
    case "danger":
      // Web `bg-danger hover:bg-danger/90`.
      return {
        bg: pressed ? "rgba(220, 38, 38, 0.9)" : ledgerStatus.danger.fg,
        fg: ledgerSurface.paper,
        border: TRANSPARENT,
      };
    case "link":
      return { bg: TRANSPARENT, fg: theme.accent.deep, border: TRANSPARENT };
  }
}

export function resolveButtonStyle({
  variant,
  size,
  pressed,
  disabled,
  theme,
}: ButtonState): ResolvedButtonStyle {
  const s = BUTTON_SIZES[size];
  const c = colours(variant, pressed && !disabled, theme);
  const isLink = variant === "link";
  const vSlop = isLink ? slopFor(s.fontSize) : slopFor(s.height);
  return {
    container: {
      // Web's compound variant: a link renders inline, with no height, padding or radius.
      height: isLink ? undefined : s.height,
      paddingHorizontal: isLink ? 0 : s.paddingX,
      borderRadius: isLink ? 0 : ledgerRadius.ctl,
      backgroundColor: c.bg,
      borderWidth: variant === "secondary" ? 1 : 0,
      borderColor: c.border,
      opacity: disabled ? 0.5 : 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      ...(variant === "secondary" ? nativeShadows.card : {}),
    },
    label: {
      fontFamily: nativeFonts.ui[500],
      fontSize: s.fontSize,
      color: c.fg,
      textDecorationLine: isLink ? "underline" : "none",
    },
    foreground: c.fg,
    hitSlop: { top: vSlop, bottom: vSlop, left: isLink ? vSlop : 0, right: isLink ? vSlop : 0 },
  };
}
