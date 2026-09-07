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
