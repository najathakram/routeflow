/**
 * Ledger tokens in React Native shape (#2330, plan §2.2 item 4). Built from `../tokens/ledger`;
 * never hand-type a value here.
 *
 * RN cannot synthesise weights for a custom font, so every weight is its own family name. The
 * names are the keys `@expo-google-fonts/*` exports, which `apps/mobile/app/_layout.tsx` loads.
 */
import type { TextStyle } from "react-native";
import {
  ledgerInk,
  ledgerRadius,
  ledgerShadow,
  ledgerTypeScale,
  type LedgerShadow,
  type LedgerTypeStep,
} from "../tokens/ledger";

export const nativeFonts = {
  ui: {
    400: "SplineSans_400Regular",
    500: "SplineSans_500Medium",
    600: "SplineSans_600SemiBold",
    700: "SplineSans_700Bold",
  },
  mono: {
    400: "SplineSansMono_400Regular",
    500: "SplineSansMono_500Medium",
  },
  display: {
    400: "InstrumentSerif_400Regular",
    "400italic": "InstrumentSerif_400Regular_Italic",
  },
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One Ledger type step as an RN text style (letter-spacing em → px). */
export function nativeTextStyle(step: LedgerTypeStep): TextStyle {
  return {
    fontFamily: nativeFonts.ui[step.weight ?? 400],
    fontSize: step.size,
    lineHeight: step.lineHeight,
    letterSpacing: round2(step.letterSpacing * step.size),
  };
}

/** The semantic type scale (web's `text-display` … `text-caption`). */
export const nativeType = {
  display: nativeTextStyle(ledgerTypeScale.display),
  heading1: nativeTextStyle(ledgerTypeScale["heading-1"]),
  heading2: nativeTextStyle(ledgerTypeScale["heading-2"]),
  body: nativeTextStyle(ledgerTypeScale.body),
  bodySm: nativeTextStyle(ledgerTypeScale["body-sm"]),
  label: nativeTextStyle(ledgerTypeScale.label),
  caption: nativeTextStyle(ledgerTypeScale.caption),
} as const;

/** Web `.money`: mono, tabular numerals, weight 500, -0.01em (at 16px). Size comes from the caller. */
export const nativeMoney: TextStyle = {
  fontFamily: nativeFonts.mono[500],
  fontVariant: ["tabular-nums"],
  letterSpacing: -0.01 * ledgerTypeScale.body.size,
};

/** Web `.eyebrow-label` (was `.overline`, #2497): 11px, 600, 0.08em, uppercase, ink-500. */
export const nativeOverline: TextStyle = {
  fontFamily: nativeFonts.ui[600],
  fontSize: 11,
  letterSpacing: round2(0.08 * 11),
  textTransform: "uppercase",
  color: ledgerInk[500],
};

/** Web `.font-display`: Instrument Serif 400, ink-900. Size comes from the caller. */
export const nativeDisplaySerif: TextStyle = {
  fontFamily: nativeFonts.display[400],
  color: ledgerInk[900],
};

const toHex = (rgb: readonly [number, number, number]) =>
  "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

export interface NativeShadow {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

/**
 * A CSS box-shadow as iOS shadow props plus Android `elevation`. iOS `shadowRadius` is roughly half
 * the CSS blur; Android elevation (dp) tracks the y-offset.
 */
export function nativeShadow(s: LedgerShadow): NativeShadow {
  return {
    shadowColor: toHex(s.rgb),
    shadowOffset: { width: s.x, height: s.y },
    shadowOpacity: s.opacity,
    shadowRadius: s.blur / 2,
    elevation: s.y,
  };
}

export const nativeShadows = {
  card: nativeShadow(ledgerShadow.card),
  dropdown: nativeShadow(ledgerShadow.dropdown),
  modal: nativeShadow(ledgerShadow.modal),
} as const;

export const nativeRadius = ledgerRadius;
