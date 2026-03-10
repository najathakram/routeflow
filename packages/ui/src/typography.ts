import type { TextStyle } from "react-native";

// React Native text style definitions using design system tokens

export const typography = {
  heading1: {
    fontFamily: "Inter",
    fontSize: 32,
    fontWeight: "700",
    lineHeight: 40,
    letterSpacing: -0.5,
  } satisfies TextStyle,

  heading2: {
    fontFamily: "Inter",
    fontSize: 24,
    fontWeight: "600",
    lineHeight: 32,
    letterSpacing: -0.25,
  } satisfies TextStyle,

  heading3: {
    fontFamily: "Inter",
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 28,
    letterSpacing: 0,
  } satisfies TextStyle,

  body: {
    fontFamily: "Inter",
    fontSize: 16,
    fontWeight: "400",
    lineHeight: 24,
    letterSpacing: 0,
  } satisfies TextStyle,

  bodySmall: {
    fontFamily: "Inter",
    fontSize: 14,
    fontWeight: "400",
    lineHeight: 20,
    letterSpacing: 0,
  } satisfies TextStyle,

  label: {
    fontFamily: "Inter",
    fontSize: 14,
    fontWeight: "500",
    lineHeight: 20,
    letterSpacing: 0.1,
  } satisfies TextStyle,

  caption: {
    fontFamily: "Inter",
    fontSize: 12,
    fontWeight: "400",
    lineHeight: 16,
    letterSpacing: 0.2,
  } satisfies TextStyle,
} as const;
