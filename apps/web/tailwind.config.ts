import type { Config } from "tailwindcss";
import preset from "@routeflow/config/tailwind";

const config: Config = {
  presets: [preset as Config],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Tenant-branded primary — overridden at runtime by TenantProvider
        primary: {
          DEFAULT: "var(--primary, #2563eb)",
          foreground: "var(--primary-foreground, #ffffff)",
        },
        // Full brand scale (preset only has 50/100/500/700/900 — extend with rest)
        brand: {
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          600: "#2563eb",
          800: "#1e40af",
        },
        // Dark-navy canvas colours used in hero / CTA sections
        canvas: {
          DEFAULT: "#0f1b2d",
          mid:     "#152238",
          light:   "#1a2d4a",
        },
      },
      // Semantic type scale — same as mobile typography.ts
      fontSize: {
        "display":   ["2rem",    { lineHeight: "2.5rem",  letterSpacing: "-0.03em", fontWeight: "700" }],
        "heading-1": ["1.5rem",  { lineHeight: "2rem",    letterSpacing: "-0.02em", fontWeight: "600" }],
        "heading-2": ["1.25rem", { lineHeight: "1.75rem", letterSpacing: "-0.01em", fontWeight: "600" }],
        "body":      ["1rem",    { lineHeight: "1.5rem",  letterSpacing: "0" }],
        "body-sm":   ["0.875rem",{ lineHeight: "1.25rem", letterSpacing: "0" }],
        "label":     ["0.875rem",{ lineHeight: "1.25rem", letterSpacing: "0.005em", fontWeight: "500" }],
        "caption":   ["0.75rem", { lineHeight: "1rem",    letterSpacing: "0.01em" }],
      },
    },
  },
  plugins: [],
  safelist: [
    // Canvas gradient utilities — used in hero / CTA sections
    "from-canvas", "via-canvas-mid", "to-canvas-mid", "to-canvas-light",
    "bg-canvas", "bg-canvas-mid", "bg-canvas-light",
    // Brand scale completions
    "bg-brand-200", "bg-brand-300", "bg-brand-400", "bg-brand-600", "bg-brand-800",
    "text-brand-200", "text-brand-300", "text-brand-400", "text-brand-600", "text-brand-800",
    "border-brand-200", "border-brand-300", "border-brand-400", "border-brand-600",
    "hover:bg-brand-600", "hover:bg-brand-700",
    "ring-brand-500", "ring-brand-600",
  ],
};
export default config;
