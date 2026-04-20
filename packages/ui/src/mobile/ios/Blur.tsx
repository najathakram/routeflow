import React from "react";
import { Platform, View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";

export interface BlurProps extends ViewProps {
  intensity?: number;
  tint?: "light" | "dark" | "default" | "prominent";
  children?: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
}

/**
 * Cross-platform blur surface. Uses expo-blur's native BlurView on iOS/Android.
 * On web, falls back to a translucent background + CSS backdrop-filter (applied
 * via inline style; react-native-web respects `backdropFilter`).
 */
export function Blur({
  intensity = 80,
  tint = "light",
  children,
  style,
  ...rest
}: BlurProps) {
  if (Platform.OS === "web") {
    const bg =
      tint === "dark"
        ? "rgba(22,22,24,0.72)"
        : "rgba(255,255,255,0.78)";
    // react-native-web passes style straight to CSS, so backdrop-filter works;
    // TS typing doesn't know that, hence the cast.
    const webStyle = {
      backgroundColor: bg,
      backdropFilter: `blur(${intensity / 4}px)`,
      WebkitBackdropFilter: `blur(${intensity / 4}px)`,
    } as unknown as ViewStyle;
    return (
      <View {...rest} style={[webStyle, style]}>
        {children}
      </View>
    );
  }
  return (
    <BlurView
      intensity={intensity}
      tint={tint}
      experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined}
      style={style as StyleProp<ViewStyle>}
      {...rest}
    >
      {children}
    </BlurView>
  );
}
