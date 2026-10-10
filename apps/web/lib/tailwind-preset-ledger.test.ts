/**
 * #2329 (T0.1): the shared Tailwind preset now builds its theme from the Ledger token source
 * instead of hand-typed hex codes. This pins the generated theme to the exact values the preset
 * shipped with before the switch, so the refactor cannot move a single web pixel.
 */
import preset from "@routeflow/config/tailwind";

const BEFORE = {
  colors: {
    brand: {
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
    },
    canvas: { DEFAULT: "#0f1b2d", mid: "#152238", light: "#1a2d4a" },
    buyer: {
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
    },
    ink: {
      900: "rgb(var(--ink-900-rgb) / <alpha-value>)",
      700: "rgb(var(--ink-700-rgb) / <alpha-value>)",
      500: "rgb(var(--ink-500-rgb) / <alpha-value>)",
      400: "rgb(var(--ink-400-rgb) / <alpha-value>)",
    },
    navy: { DEFAULT: "rgb(var(--ink-900-rgb) / <alpha-value>)", light: "#2563EB" },
    accent: {
      DEFAULT: "var(--accent)",
      strong: "var(--accent-strong)",
      deep: "var(--accent-deep)",
      soft: "var(--accent-soft)",
    },
    paper: "var(--paper)",
    sunken: "var(--sunken)",
    line: { DEFAULT: "var(--line)", strong: "var(--line-strong)" },
    success: { DEFAULT: "#16a34a", bg: "#dcfce7" },
    warning: { DEFAULT: "#d97706", bg: "#fef3c7" },
    danger: { DEFAULT: "#dc2626", bg: "#fee2e2" },
    info: { DEFAULT: "#0284c7", bg: "#e0f2fe" },
    surface: { DEFAULT: "#ffffff", raised: "#f7f9fc", border: "#e2e8f0" },
  },
  fontFamily: {
    sans: ["var(--font-spline)", "var(--font-inter)", "Inter", "system-ui", "sans-serif"],
    mono: ["var(--font-spline-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
    display: ["var(--font-instrument-serif)", "Georgia", "serif"],
  },
  fontSize: {
    display: ["2rem", { lineHeight: "2.5rem", letterSpacing: "-0.03em", fontWeight: "700" }],
    "heading-1": ["1.5rem", { lineHeight: "2rem", letterSpacing: "-0.02em", fontWeight: "600" }],
    "heading-2": [
      "1.25rem",
      { lineHeight: "1.75rem", letterSpacing: "-0.01em", fontWeight: "600" },
    ],
    body: ["1rem", { lineHeight: "1.5rem", letterSpacing: "0" }],
    "body-sm": ["0.875rem", { lineHeight: "1.25rem", letterSpacing: "0" }],
    label: ["0.875rem", { lineHeight: "1.25rem", letterSpacing: "0.005em", fontWeight: "500" }],
    caption: ["0.75rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
  },
  borderRadius: {
    sm: "4px",
    ctl: "6px",
    DEFAULT: "8px",
    card: "10px",
    lg: "12px",
    xl: "16px",
    full: "9999px",
  },
  boxShadow: {
    card: "0 1px 2px rgba(15,27,45,.05)",
    dropdown: "0 8px 24px rgba(15,27,45,.14)",
    modal: "0 24px 64px rgba(15,27,45,.28)",
  },
};

describe("Tailwind preset built from the Ledger tokens (#2329)", () => {
  const extend = (preset.theme as { extend: Record<string, unknown> }).extend;

  it.each(Object.keys(BEFORE) as Array<keyof typeof BEFORE>)(
    "theme.extend.%s is unchanged",
    (key) => {
      expect(extend[key]).toEqual(BEFORE[key]);
    },
  );

  it("takes its values from @routeflow/ui/ledger, not hand-typed hex", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "..", "packages", "config", "tailwind.config.ts"),
      "utf8",
    ) as string;
    expect(src).toMatch(/from "@routeflow\/ui\/ledger"/);
    expect(src.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
  });
});
