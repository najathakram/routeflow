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
          DEFAULT: "var(--primary, #3B82F6)",
          foreground: "var(--primary-foreground, #ffffff)",
        },
      },
    },
  },
  plugins: [],
};
export default config;
