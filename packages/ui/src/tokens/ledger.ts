/**
 * The Ledger design tokens: the ONE source for web and native (#2329, epic #2328 §2.2).
 *
 * - Web: `packages/config/tailwind.config.ts` builds its theme from these values, and
 *   `apps/web/app/globals.css` is pinned to `ledgerCssVars()` by
 *   `apps/web/lib/ledger-css-parity.test.ts` (CSS cannot import TS, so the spec is the guard).
 * - Native: the mobile theme is built from these values in #2330.
 *
 * Plain data only: no platform code, so both apps can import it. Dark mode is out of scope; the
 * semantic layer (paper, canvas, ink, line) is where a dark palette would plug in.
 */

/** The static teal brand scale (tenant `--primary` overrides it at runtime on web). */
export const ledgerBrand = {
  50: "#E8F2F1",
  100: "#D4E9E8",
  200: "#A9D5D2",
  300: "#7FD1CD",
  400: "#3FB8B3",
  500: "#14A39F",
  600: "#0E8480",
  700: "#0B6E6B",
  800: "#095856",
  900: "#073F3E",
} as const;

/** The buyer portal's emerald scale. */
export const ledgerBuyerScale = {
  50: "#ecfdf5",
  100: "#d1fae5",
  200: "#a7f3d0",
  300: "#6ee7b7",
  400: "#34d399",
  500: "#10b981",
  600: "#059669",
  700: "#047857",
  800: "#065f46",
  900: "#064e3b",
} as const;

/** Dark-navy canvas colours for marketing hero / CTA sections (web marketing only). */
export const ledgerMarketingCanvas = {
  DEFAULT: "#0f1b2d",
  mid: "#152238",
  light: "#1a2d4a",
} as const;

/** Ink neutrals: 900 = primary text and the rail, 700 = body text. */
export const ledgerInk = {
  900: "#0f1b2d",
  700: "#33425b",
  500: "#5c6b82",
  400: "#8b97ac",
} as const;

/**
 * Pre-Ledger values still used by legacy callers. Not part of the Ledger palette: do not use
 * in new work; delete an entry once its last caller is gone.
 */
export const ledgerLegacy = {
  /** Tailwind `navy-light` (old blue accent). */
  navyLight: "#2563EB",
} as const;

/** Surfaces and hairlines. `canvas` is the light page background. */
export const ledgerSurface = {
  paper: "#ffffff",
  canvas: "#f7f9fc",
  sunken: "#edf1f6",
  line: "#e2e8f0",
  lineStrong: "#d6dee8",
} as const;

/** One status set everywhere: a foreground and its tint. */
export const ledgerStatus = {
  success: { fg: "#16a34a", bg: "#dcfce7" },
  warning: { fg: "#d97706", bg: "#fef3c7" },
  danger: { fg: "#dc2626", bg: "#fee2e2" },
  info: { fg: "#0284c7", bg: "#e0f2fe" },
} as const;

export type LedgerSurface = "operator" | "buyer";

export interface LedgerAccent {
  accent: string;
  strong: string;
  deep: string;
  soft: string;
  /** Faint wash behind accent content. */
  mist: string;
}

/**
 * Per-surface accent (web's `--accent*` knob). Operator follows the tenant brand, so its static
 * default is the brand teal; buyer is emerald.
 */
export const ledgerAccents: Record<LedgerSurface, LedgerAccent> = {
  operator: {
    accent: ledgerBrand[500],
    strong: ledgerBrand[600],
    deep: ledgerBrand[700],
    soft: ledgerBrand[50],
    mist: "#f2f8f8",
  },
  buyer: {
    accent: ledgerBuyerScale[600],
    strong: ledgerBuyerScale[700],
    deep: ledgerBuyerScale[800],
    soft: ledgerBuyerScale[50],
    mist: "#f0fbf6",
  },
};

/** Per-surface density (web's `--row-h` / `--text-body` knob), in px. */
export const ledgerDensity: Record<LedgerSurface, { rowHeight: number; textBody: number }> = {
  operator: { rowHeight: 44, textBody: 13.5 },
  buyer: { rowHeight: 52, textBody: 14 },
};

/** Corner radii in px: controls 6, cards 10. */
export const ledgerRadius = {
  sm: 4,
  ctl: 6,
  default: 8,
  card: 10,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export interface LedgerShadow {
  x: number;
  y: number;
  blur: number;
  /** Always ink-900 (15, 27, 45). */
  rgb: readonly [number, number, number];
  opacity: number;
}

/** Elevation, hairline-first. */
export const ledgerShadow: Record<"card" | "dropdown" | "modal", LedgerShadow> = {
  card: { x: 0, y: 1, blur: 2, rgb: [15, 27, 45], opacity: 0.05 },
  dropdown: { x: 0, y: 8, blur: 24, rgb: [15, 27, 45], opacity: 0.14 },
  modal: { x: 0, y: 24, blur: 64, rgb: [15, 27, 45], opacity: 0.28 },
};

/** Font families (web loads them via next/font; native via @expo-google-fonts in #2330). */
export const ledgerFonts = {
  ui: "Spline Sans",
  mono: "Spline Sans Mono",
  display: "Instrument Serif",
} as const;

export interface LedgerTypeStep {
  /** px */
  size: number;
  /** px */
  lineHeight: number;
  /** em */
  letterSpacing: number;
  weight?: 500 | 600 | 700;
}

/** The semantic 6-step type scale (+ label), in px. */
export const ledgerTypeScale = {
  display: { size: 32, lineHeight: 40, letterSpacing: -0.03, weight: 700 },
  "heading-1": { size: 24, lineHeight: 32, letterSpacing: -0.02, weight: 600 },
  "heading-2": { size: 20, lineHeight: 28, letterSpacing: -0.01, weight: 600 },
  body: { size: 16, lineHeight: 24, letterSpacing: 0 },
  "body-sm": { size: 14, lineHeight: 20, letterSpacing: 0 },
  label: { size: 14, lineHeight: 20, letterSpacing: 0.005, weight: 500 },
  caption: { size: 12, lineHeight: 16, letterSpacing: 0.01 },
} as const satisfies Record<string, LedgerTypeStep>;

// ─── Web emitters ────────────────────────────────────────────────────────────────

const rgbChannels = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

/** `0 1px 2px rgba(15, 27, 45, 0.05)`: the CSS-var spelling of a shadow. */
export function cssShadow(s: LedgerShadow): string {
  return `${s.x} ${s.y}px ${s.blur}px rgba(${s.rgb.join(", ")}, ${s.opacity})`;
}

/**
 * The exact custom properties `globals.css` must declare for a surface. `operator` is the full
 * `:root` block; `buyer` is the `.surface-buyer` override block.
 */
export function ledgerCssVars(surface: LedgerSurface): Record<string, string> {
  const density = ledgerDensity[surface];
  if (surface === "buyer") {
    const a = ledgerAccents.buyer;
    return {
      "--accent": a.accent,
      "--accent-strong": a.strong,
      "--accent-deep": a.deep,
      "--accent-soft": a.soft,
      "--primary-mist": a.mist,
      "--row-h": `${density.rowHeight}px`,
      "--text-body": `${density.textBody}px`,
    };
  }
  const lower = (hex: string) => hex.toLowerCase();
  return {
    "--ink-900": ledgerInk[900],
    "--ink-700": ledgerInk[700],
    "--ink-500": ledgerInk[500],
    "--ink-400": ledgerInk[400],
    "--ink-900-rgb": rgbChannels(ledgerInk[900]),
    "--ink-700-rgb": rgbChannels(ledgerInk[700]),
    "--ink-500-rgb": rgbChannels(ledgerInk[500]),
    "--ink-400-rgb": rgbChannels(ledgerInk[400]),
    "--paper": ledgerSurface.paper,
    "--canvas": ledgerSurface.canvas,
    "--sunken": ledgerSurface.sunken,
    "--line": ledgerSurface.line,
    "--line-strong": ledgerSurface.lineStrong,
    "--brand-700": lower(ledgerBrand[700]),
    "--brand-600": lower(ledgerBrand[600]),
    "--brand-500": lower(ledgerBrand[500]),
    "--brand-300": lower(ledgerBrand[300]),
    "--brand-50": lower(ledgerBrand[50]),
    "--primary": "var(--brand-500)",
    "--primary-strong": "var(--brand-600)",
    "--primary-deep": "var(--brand-700)",
    "--primary-soft": "var(--brand-50)",
    "--primary-mist": ledgerAccents.operator.mist,
    "--primary-foreground": ledgerSurface.paper,
    "--accent": "var(--primary)",
    "--accent-strong": "var(--primary-strong)",
    "--accent-deep": "var(--primary-deep)",
    "--accent-soft": "var(--primary-soft)",
    "--background": "var(--paper)",
    "--foreground": "var(--ink-700)",
    "--surface-raised": "var(--canvas)",
    "--surface-border": "var(--line)",
    "--success": ledgerStatus.success.fg,
    "--success-bg": ledgerStatus.success.bg,
    "--warning": ledgerStatus.warning.fg,
    "--warning-bg": ledgerStatus.warning.bg,
    "--danger": ledgerStatus.danger.fg,
    "--danger-bg": ledgerStatus.danger.bg,
    "--info": ledgerStatus.info.fg,
    "--info-bg": ledgerStatus.info.bg,
    "--r-ctl": `${ledgerRadius.ctl}px`,
    "--r-card": `${ledgerRadius.card}px`,
    "--sh-card": cssShadow(ledgerShadow.card),
    "--sh-drop": cssShadow(ledgerShadow.dropdown),
    "--sh-modal": cssShadow(ledgerShadow.modal),
    "--font-ui": `var(--font-spline), "${ledgerFonts.ui}", system-ui, sans-serif`,
    "--font-mono": `var(--font-spline-mono), "${ledgerFonts.mono}", ui-monospace, monospace`,
    "--font-display": `var(--font-instrument-serif), "${ledgerFonts.display}", Georgia, serif`,
    "--row-h": `${density.rowHeight}px`,
    "--text-body": `${density.textBody}px`,
  };
}
