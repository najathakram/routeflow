/**
 * Text-field styling for the native kit (#2331), mirroring web `Input` / `PasswordInput` /
 * `Textarea` (`packages/ui/src/web/`). It is pure, so jest can pin it.
 *
 * Web draws focus as a 2px `brand-500` ring over a transparent border. Native draws it as a 2px
 * border, trimming the padding by 1px so the text does not shift when focus changes.
 */
import {
  ledgerBrand,
  ledgerInk,
  ledgerRadius,
  ledgerStatus,
  ledgerSurface,
} from "../tokens/ledger";
import { nativeFonts } from "./tokens";

export const FIELD_HEIGHT = 40;
export const TEXTAREA_MIN_HEIGHT = 80;
const PAD_X = 12;
const PAD_Y = 8;

/** Web `placeholder:text-navy/70` (ink-900 at 70%). */
export const FIELD_PLACEHOLDER = "rgba(15, 27, 45, 0.7)";

export interface FieldState {
  focused: boolean;
  error: boolean;
  disabled: boolean;
  multiline?: boolean;
  /** Extra right padding for a trailing control (the password toggle). */
  trailingInset?: number;
}

export interface ResolvedFieldStyle {
  input: {
    height?: number;
    minHeight?: number;
    paddingHorizontal: number;
    paddingLeft: number;
    paddingRight: number;
    paddingVertical: number;
    borderRadius: number;
    borderWidth: number;
    borderColor: string;
    backgroundColor: string;
    fontFamily: string;
    fontSize: number;
    color: string;
    opacity: number;
    textAlignVertical: "top" | "center";
  };
  label: { fontFamily: string; fontSize: number; lineHeight: number; color: string };
  error: { fontFamily: string; fontSize: number; lineHeight: number; color: string };
  helper: { fontFamily: string; fontSize: number; lineHeight: number; color: string };
  placeholderTextColor: string;
}

export function resolveFieldStyle({
  focused,
  error,
  disabled,
  multiline = false,
  trailingInset = 0,
}: FieldState): ResolvedFieldStyle {
  const ring = focused && !disabled;
  const borderWidth = ring ? 2 : 1;
  const inset = borderWidth - 1;
  const borderColor = error ? ledgerStatus.danger.fg : ring ? ledgerBrand[500] : ledgerSurface.line;
  return {
    input: {
      height: multiline ? undefined : FIELD_HEIGHT,
      minHeight: multiline ? TEXTAREA_MIN_HEIGHT : undefined,
      paddingHorizontal: PAD_X - inset,
      paddingLeft: PAD_X - inset,
      paddingRight: PAD_X - inset + trailingInset,
      paddingVertical: multiline ? PAD_Y - inset : 0,
      borderRadius: ledgerRadius.default,
      borderWidth,
      borderColor,
      backgroundColor: disabled ? ledgerSurface.canvas : ledgerSurface.paper,
      fontFamily: nativeFonts.ui[400],
      fontSize: 14,
      color: ledgerInk[900],
      opacity: disabled ? 0.5 : 1,
      textAlignVertical: multiline ? "top" : "center",
    },
    label: { fontFamily: nativeFonts.ui[500], fontSize: 14, lineHeight: 20, color: ledgerInk[900] },
    error: {
      fontFamily: nativeFonts.ui[400],
      fontSize: 12,
      lineHeight: 16,
      color: ledgerStatus.danger.fg,
    },
    helper: {
      fontFamily: nativeFonts.ui[400],
      fontSize: 12,
      lineHeight: 16,
      color: ledgerInk[500],
    },
    placeholderTextColor: FIELD_PLACEHOLDER,
  };
}
