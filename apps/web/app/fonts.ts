import localFont from "next/font/local";

// Marketing site typeface — Geist / Geist Mono, self-hosted (redesign
// portability §Fonts). Scoped to `.rf-marketing` in marketing.css; nothing
// outside the marketing surface reads these variables. Loaded once at the
// root per Next's font-optimization contract (next/font/local throws if
// used outside a module scope reached from the root layout).
export const geistSans = localFont({
  src: "../fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

export const geistMono = localFont({
  src: "../fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

// ── App typefaces (#2397): self-hosted instead of `next/font/google`, whose build-time fetch
// failed prod deploys. Same files Google serves (latin subset, the variable fonts cover the
// weight ranges below), same CSS variables, so every style that reads them is unchanged.

// Ledger UI typeface. Drives `font-sans` app-wide via --font-spline.
export const splineSans = localFont({
  src: "../fonts/SplineSans-Variable-latin.woff2",
  variable: "--font-spline",
  weight: "400 700",
  display: "swap",
});

// Ledger monospace — money columns and codes (tabular-nums) via .money / .mono.
export const splineSansMono = localFont({
  src: "../fonts/SplineSansMono-Variable-latin.woff2",
  variable: "--font-spline-mono",
  weight: "400 600",
  display: "swap",
});

// Kept as a fallback in the font stack during the Spline Sans migration.
export const inter = localFont({
  src: "../fonts/Inter-Variable-latin.woff2",
  variable: "--font-inter",
  weight: "400 700",
  display: "swap",
});

// Display serif. The italic face drives the <em> styling in display headings.
export const instrumentSerif = localFont({
  src: [
    { path: "../fonts/InstrumentSerif-Regular-latin.woff2", weight: "400", style: "normal" },
    { path: "../fonts/InstrumentSerif-Italic-latin.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-instrument-serif",
  display: "swap",
});
