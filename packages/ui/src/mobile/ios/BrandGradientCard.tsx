import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { ios } from "../../tokens";

export interface BrandGradientCardProps {
  children: React.ReactNode;
  radius?: number;
  padding?: number;
  style?: ViewStyle;
}

/**
 * Hero card with the brand teal gradient. Used on driver home, operator
 * readiness, credit-note outcome, and the like.
 */
export function BrandGradientCard({
  children,
  radius = 20,
  padding = 18,
  style,
}: BrandGradientCardProps) {
  return (
    <LinearGradient
      colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[{ borderRadius: radius, padding, overflow: "hidden" as const }, style]}
    >
      <View>{children}</View>
    </LinearGradient>
  );
}

export const brandGradientStyles = StyleSheet.create({
  eyebrow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.8)",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -0.6,
    marginTop: 4,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.85)",
    marginTop: 2,
  },
});
