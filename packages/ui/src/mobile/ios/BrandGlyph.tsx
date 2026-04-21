import React from "react";
import Svg, { Path, Circle } from "react-native-svg";

export interface BrandGlyphProps {
  size?: number;
  color?: string;
  stroke?: string;
}

/** RouteFlow route-connector glyph — native version (react-native-svg).
 * Double-circle bullseye design matching the website logo, with teal gradient background.
 */
export function BrandGlyph({ size = 34, color = "#fff", stroke }: BrandGlyphProps) {
  const c = stroke ?? color;
  const accent = "#2563EB";
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Connecting curve from origin to destination */}
      <Path
        d="M7.5 7 C5 13 19 11 16.5 17"
        stroke={c}
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0.45}
      />
      {/* Origin node: white disc with blue centre */}
      <Circle cx="7.5" cy="7" r="3.5" fill={c} />
      <Circle cx="7.5" cy="7" r="1.8" fill={accent} />
      {/* Destination node: blue ring with white fill */}
      <Circle cx="16.5" cy="17" r="3.5" stroke={accent} strokeWidth={2} fill="none" />
      <Circle cx="16.5" cy="17" r="1.8" fill={c} />
    </Svg>
  );
}
