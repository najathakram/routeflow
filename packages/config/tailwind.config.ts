import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const preset: Omit<Config, "content"> = {
  plugins: [animate],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#f0faf9",
          100: "#ccefee",
          200: "#9adedd",
          300: "#67cecc",
          400: "#34bebb",
          500: "#0b9e9b",
          600: "#0b6e6b",
          700: "#08524f",
          800: "#063836",
          900: "#042523",
        },
        // Dark-navy canvas colours used in hero / CTA sections
        canvas: {
          DEFAULT: "#0f1b2d",
          mid:     "#152238",
          light:   "#1a2d4a",
        },
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
        navy: {
          DEFAULT: "#1B3A5C",
          light: "#2563EB",
        },
        success: {
          DEFAULT: "#16a34a",
          bg: "#dcfce7",
        },
        warning: {
          DEFAULT: "#d97706",
          bg: "#fef3c7",
        },
        danger: {
          DEFAULT: "#dc2626",
          bg: "#fee2e2",
        },
        surface: {
          DEFAULT: "#ffffff",
          raised: "#f8fafc",
          border: "#e2e8f0",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
      },
      // Semantic 6-step type scale — mirrors packages/ui/src/typography.ts for mobile
      fontSize: {
        "display":    ["2rem",    { lineHeight: "2.5rem",  letterSpacing: "-0.03em", fontWeight: "700" }],
        "heading-1":  ["1.5rem",  { lineHeight: "2rem",    letterSpacing: "-0.02em", fontWeight: "600" }],
        "heading-2":  ["1.25rem", { lineHeight: "1.75rem", letterSpacing: "-0.01em", fontWeight: "600" }],
        "body":       ["1rem",    { lineHeight: "1.5rem",  letterSpacing: "0" }],
        "body-sm":    ["0.875rem",{ lineHeight: "1.25rem", letterSpacing: "0" }],
        "label":      ["0.875rem",{ lineHeight: "1.25rem", letterSpacing: "0.005em", fontWeight: "500" }],
        "caption":    ["0.75rem", { lineHeight: "1rem",    letterSpacing: "0.01em" }],
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "8px",
        lg: "12px",
        xl: "16px",
        full: "9999px",
      },
      boxShadow: {
        card: "0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.06)",
        dropdown: "0 4px 6px -1px rgb(0 0 0 / 0.12), 0 2px 4px -2px rgb(0 0 0 / 0.08)",
        modal: "0 20px 25px -5px rgb(0 0 0 / 0.15), 0 8px 10px -6px rgb(0 0 0 / 0.10)",
      },
    },
  },
};

export default preset;
