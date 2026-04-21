import React from "react";
import { View } from "react-native";

export interface BrandGlyphProps {
  size?: number;
  color?: string;
  stroke?: string;
}

/** RouteFlow route-connector glyph — web version (raw SVG via dangerouslySetInnerHTML). */
export function BrandGlyph({ size = 34, color = "#fff", stroke }: BrandGlyphProps) {
  const c = stroke ?? color;
  const svgMarkup =
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">` +
    `<path d="M7.5 7 C5 13 19 11 16.5 17" stroke="${c}" stroke-width="2" stroke-linecap="round" opacity="0.55"/>` +
    `<circle cx="7.5" cy="7" r="3" fill="${c}"/>` +
    `<circle cx="16.5" cy="17" r="3" stroke="${c}" stroke-width="2" fill="none"/>` +
    "</svg>";
  return (
    <View
      // @ts-expect-error — react-native-web accepts dangerouslySetInnerHTML on View
      dangerouslySetInnerHTML={{ __html: svgMarkup }}
      style={{ width: size, height: size }}
    />
  );
}
