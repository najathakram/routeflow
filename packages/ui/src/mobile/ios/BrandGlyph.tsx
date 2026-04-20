import React from "react";
import Svg, { Path } from "react-native-svg";

export interface BrandGlyphProps {
  size?: number;
  stroke?: string;
}

/** RouteFlow building glyph — native version (uses react-native-svg). */
export function BrandGlyph({ size = 34, stroke = "#fff" }: BrandGlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 17L12 13L20 17M4 17L12 21L20 17M4 17V9L12 5L20 9V17M12 13V5"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
