import React from "react";
import Svg, { Path, Circle } from "react-native-svg";

export interface BrandGlyphProps {
  size?: number;
  color?: string;
  stroke?: string;
}

/** RouteFlow route-connector glyph — native version (react-native-svg). */
export function BrandGlyph({ size = 34, color = "#fff", stroke }: BrandGlyphProps) {
  const c = stroke ?? color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Connecting curve from origin to destination */}
      <Path
        d="M7.5 7 C5 13 19 11 16.5 17"
        stroke={c}
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0.55}
      />
      {/* Origin node: solid filled circle */}
      <Circle cx="7.5" cy="7" r="3" fill={c} />
      {/* Destination node: ring */}
      <Circle cx="16.5" cy="17" r="3" stroke={c} strokeWidth={2} fill="none" />
    </Svg>
  );
}
