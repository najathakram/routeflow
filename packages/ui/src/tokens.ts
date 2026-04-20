// Design system tokens for use in React Native StyleSheet
// (React Native does not support Tailwind CSS)

export const colors = {
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

// iOS-style token namespace for the Apple-style mobile re-skin (driver + operator).
// Customer/buyer screens keep using `colors` above. New screens import from here.
export const ios = {
  system: {
    red: "#FF3B30",
    redInk: "#C9302C",
    redWash: "rgba(255,59,48,0.10)",
    orange: "#FF9500",
    orangeInk: "#B56300",
    orangeWash: "rgba(255,149,0,0.12)",
    yellow: "#FFCC00",
    yellowInk: "#7D5800",
    yellowWash: "rgba(255,204,0,0.15)",
    green: "#34C759",
    greenInk: "#248A3D",
    greenWash: "rgba(52,199,89,0.12)",
    purple: "#AF52DE",
    purpleInk: "#6B2D9E",
    purpleWash: "rgba(175,82,222,0.10)",
    indigo: "#5856D6",
  },
  gray: {
    1: "#8E8E93",
    2: "#AEAEB2",
    3: "#C7C7CC",
    4: "#D1D1D6",
    5: "#E5E5EA",
    6: "#F2F2F7",
  },
  bg: "#F2F2F7",
  bgElev: "#FFFFFF",
  bgGrouped: "#F2F2F7",
  label: "#000000",
  label2: "rgba(60,60,67,0.60)",
  label3: "rgba(60,60,67,0.30)",
  separator: "rgba(60,60,67,0.12)",
  fill: "rgba(120,120,128,0.20)",
  fill2: "rgba(120,120,128,0.16)",
  fill3: "rgba(120,120,128,0.12)",
  brand: "#0B6E6B",
  brandInk: "#073F3D",
  brandWash: "rgba(11,110,107,0.10)",
  brandWashStrong: "rgba(11,110,107,0.16)",
  brandGradient: ["#0B6E6B", "#0A5655", "#083F3E"] as readonly string[],
  rowPadY: 11,
  rowMinH: 44,
  cardRadius: 16,
  listRadius: 12,
} as const;
