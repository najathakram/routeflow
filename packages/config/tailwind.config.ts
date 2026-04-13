import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const preset: Omit<Config, "content"> = {
  plugins: [animate],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          500: "#3b82f6",
          700: "#1d4ed8",
          900: "#1e3a8a",
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
