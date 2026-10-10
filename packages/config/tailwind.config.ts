import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
import {
  ledgerBrand,
  ledgerBuyerScale,
  ledgerLegacy,
  ledgerMarketingCanvas,
  ledgerRadius,
  ledgerShadow,
  ledgerStatus,
  ledgerSurface,
  ledgerTypeScale,
  type LedgerShadow,
  type LedgerTypeStep,
} from "@routeflow/ui/ledger";

// #2329: every value below comes from the ONE Ledger token source (packages/ui/src/tokens/
// ledger.ts), which native shares. apps/web/lib/tailwind-preset-ledger.test.ts pins the output.

/** `0 1px 2px rgba(15,27,45,.05)`: Tailwind's compact spelling of a Ledger shadow. */
const twShadow = (s: LedgerShadow) =>
  `${s.x} ${s.y}px ${s.blur}px rgba(${s.rgb.join(",")},${String(s.opacity).replace(/^0/, "")})`;

/** A Ledger type step as a Tailwind fontSize tuple (px → rem, letter-spacing in em). */
const twType = ({ size, lineHeight, letterSpacing, weight }: LedgerTypeStep) =>
  [
    `${size / 16}rem`,
    {
      lineHeight: `${lineHeight / 16}rem`,
      letterSpacing: letterSpacing === 0 ? "0" : `${letterSpacing}em`,
      ...(weight ? { fontWeight: String(weight) } : {}),
    },
  ] as [string, Record<string, string>];

const status = (k: keyof typeof ledgerStatus) => ({
  DEFAULT: ledgerStatus[k].fg,
  bg: ledgerStatus[k].bg,
});

const preset: Omit<Config, "content"> = {
  plugins: [animate],
  theme: {
    extend: {
      colors: {
        // ── Ledger brand (teal) — default/fallback; tenant --primary overrides --accent at runtime ──
        brand: { ...ledgerBrand },
        // Dark-navy canvas colours used in hero / CTA sections (marketing only)
        canvas: { ...ledgerMarketingCanvas },
        buyer: { ...ledgerBuyerScale },
        // ── Ledger ink neutrals ──
        // rgb(var(--x-rgb) / <alpha-value>) so opacity modifiers work
        // (text-ink-500/60, and the ~2.2k existing text-navy/70, bg-navy/10 uses).
        ink: {
          900: "rgb(var(--ink-900-rgb) / <alpha-value>)",
          700: "rgb(var(--ink-700-rgb) / <alpha-value>)",
          500: "rgb(var(--ink-500-rgb) / <alpha-value>)",
          400: "rgb(var(--ink-400-rgb) / <alpha-value>)",
        },
        // navy = ink-900 (rail, primary text). `light` kept for legacy callers.
        navy: {
          DEFAULT: "rgb(var(--ink-900-rgb) / <alpha-value>)",
          light: ledgerLegacy.navyLight,
        },
        // ── Per-surface accent (operator teal / buyer emerald / admin indigo) ──
        accent: {
          DEFAULT: "var(--accent)",
          strong: "var(--accent-strong)",
          deep: "var(--accent-deep)",
          soft: "var(--accent-soft)",
        },
        paper: "var(--paper)",
        sunken: "var(--sunken)",
        line: {
          DEFAULT: "var(--line)",
          strong: "var(--line-strong)",
        },
        success: status("success"),
        warning: status("warning"),
        danger: status("danger"),
        info: status("info"),
        surface: {
          DEFAULT: ledgerSurface.paper,
          // Ledger light page canvas. `canvas` (dark navy) is taken by marketing.
          raised: ledgerSurface.canvas,
          border: ledgerSurface.line,
        },
      },
      fontFamily: {
        // Spline Sans (Ledger UI) first; Inter kept as fallback during migration.
        sans: ["var(--font-spline)", "var(--font-inter)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-spline-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        display: ["var(--font-instrument-serif)", "Georgia", "serif"],
      },
      // Semantic 6-step type scale — mirrors packages/ui/src/typography.ts for mobile
      fontSize: {
        display: twType(ledgerTypeScale.display),
        "heading-1": twType(ledgerTypeScale["heading-1"]),
        "heading-2": twType(ledgerTypeScale["heading-2"]),
        body: twType(ledgerTypeScale.body),
        "body-sm": twType(ledgerTypeScale["body-sm"]),
        label: twType(ledgerTypeScale.label),
        caption: twType(ledgerTypeScale.caption),
      },
      borderRadius: {
        sm: `${ledgerRadius.sm}px`,
        // Ledger corner language: controls 6px, cards 10px.
        ctl: `${ledgerRadius.ctl}px`,
        DEFAULT: `${ledgerRadius.default}px`,
        card: `${ledgerRadius.card}px`,
        lg: `${ledgerRadius.lg}px`,
        xl: `${ledgerRadius.xl}px`,
        full: `${ledgerRadius.full}px`,
      },
      boxShadow: {
        // Ledger elevation — hairline-first.
        card: twShadow(ledgerShadow.card),
        dropdown: twShadow(ledgerShadow.dropdown),
        modal: twShadow(ledgerShadow.modal),
      },
    },
  },
};

export default preset;
