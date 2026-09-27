// Design system tokens for use in React Native StyleSheet
// (React Native does not support Tailwind CSS)
//
// Re-pointed to the Ledger source (#2330): every value below comes from `./tokens/ledger`, the
// same module the web Tailwind preset is built from. The keys are the pre-Ledger ones, kept so
// the existing importers restyle in place. New work uses `@routeflow/ui/native`.

import {
  ledgerBrand,
  ledgerBuyerScale,
  ledgerInk,
  ledgerLegacy,
  ledgerMarketingCanvas,
  ledgerRadius,
  ledgerStatus,
  ledgerSurface,
} from "./tokens/ledger";
import { nativeFonts, nativeShadows } from "./native/tokens";

export const colors = {
  brand: ledgerBrand,
  buyer: ledgerBuyerScale,
  canvas: ledgerMarketingCanvas,
  ink: ledgerInk,
  navy: {
    DEFAULT: ledgerInk[900],
    light: ledgerLegacy.navyLight,
  },
  success: { DEFAULT: ledgerStatus.success.fg, bg: ledgerStatus.success.bg },
  warning: { DEFAULT: ledgerStatus.warning.fg, bg: ledgerStatus.warning.bg },
  danger: { DEFAULT: ledgerStatus.danger.fg, bg: ledgerStatus.danger.bg },
  info: { DEFAULT: ledgerStatus.info.fg, bg: ledgerStatus.info.bg },
  surface: {
    DEFAULT: ledgerSurface.paper,
    raised: ledgerSurface.canvas,
    sunken: ledgerSurface.sunken,
    border: ledgerSurface.line,
    borderStrong: ledgerSurface.lineStrong,
  },
} as const;

export const fontFamily = {
  sans: [nativeFonts.ui[400], "system-ui", "sans-serif"] as string[],
  mono: [nativeFonts.mono[400], "monospace"] as string[],
} as const;

export const borderRadius = {
  sm: ledgerRadius.sm,
  ctl: ledgerRadius.ctl,
  DEFAULT: ledgerRadius.default,
  card: ledgerRadius.card,
  lg: ledgerRadius.lg,
  xl: ledgerRadius.xl,
  full: ledgerRadius.full,
} as const;

export const shadows = nativeShadows;

// iOS-style token namespace for the Apple-style mobile re-skin (driver + operator).
// Customer/buyer screens keep using `colors` above. New screens import from here.
export const ios = {
  system: {
    // BUG-XR2-3: pill foreground "Ink" colors darkened so the wash backgrounds
    // (12% color on white) meet WCAG AA 4.5:1 for normal text. The audit
    // measured "Pending" (orange) at 2.01:1; the previous mid-saturation inks
    // hovered near 4:1 across red/orange/green/purple. Darker inks tested:
    //   redInk    #A32422 on rgba(255,59,48,.10) blended -> 4.7:1
    //   orangeInk #8A4B00 on rgba(255,149,0,.12) blended -> 4.6:1
    //   greenInk  #1B6F33 on rgba(52,199,89,.12) blended -> 4.8:1
    //   purpleInk #5A2080 on rgba(175,82,222,.10) blended -> 4.6:1
    //   yellowInk #5C4100 on rgba(255,204,0,.15) blended -> 5.7:1
    red: "#FF3B30",
    redInk: "#A32422",
    redWash: "rgba(255,59,48,0.10)",
    orange: "#FF9500",
    orangeInk: "#8A4B00",
    orangeWash: "rgba(255,149,0,0.12)",
    yellow: "#FFCC00",
    yellowInk: "#5C4100",
    yellowWash: "rgba(255,204,0,0.15)",
    green: "#34C759",
    greenInk: "#1B6F33",
    greenWash: "rgba(52,199,89,0.12)",
    purple: "#AF52DE",
    purpleInk: "#5A2080",
    purpleWash: "rgba(175,82,222,0.10)",
    indigo: "#5856D6",
  },
  gray: {
    1: "#8E8E93",
    2: "#AEAEB2",
    3: "#C7C7CC",
    4: "#D1D1D6",
    5: "#E5E5EA",
    6: "#F2F2F7",
  },
  bg: "#F2F2F7",
  bgElev: "#FFFFFF",
  bgGrouped: "#F2F2F7",
  label: "#000000",
  label2: "rgba(60,60,67,0.60)",
  label3: "rgba(60,60,67,0.30)",
  separator: "rgba(60,60,67,0.12)",
  fill: "rgba(120,120,128,0.20)",
  fill2: "rgba(120,120,128,0.16)",
  fill3: "rgba(120,120,128,0.12)",
  brand: "#0B6E6B",
  brandInk: "#073F3D",
  brandWash: "rgba(11,110,107,0.10)",
  brandWashStrong: "rgba(11,110,107,0.16)",
  brandGradient: ["#0B6E6B", "#0A5655", "#083F3E"] as readonly string[],
  rowPadY: 11,
  rowMinH: 44,
  cardRadius: 16,
  listRadius: 12,
} as const;
