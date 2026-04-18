// Design system tokens for use in React Native StyleSheet
// (React Native does not support Tailwind CSS)

export const colors = {
  brand: {
    50:  "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
    800: "#1e40af",
    900: "#1e3a8a",
  },
  canvas: {
    DEFAULT: "#0f1b2d",
    mid:     "#152238",
    light:   "#1a2d4a",
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
} as const;

export const fontFamily = {
  sans: ["Inter", "system-ui", "sans-serif"] as string[],
} as const;

export const borderRadius = {
  sm: 4,
  DEFAULT: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const shadows = {
  card: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  dropdown: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
  },
  modal: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.15,
    shadowRadius: 25,
    elevation: 10,
  },
} as const;
