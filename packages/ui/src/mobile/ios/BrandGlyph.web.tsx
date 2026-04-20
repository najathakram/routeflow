import React from "react";
import { View } from "react-native";

export interface BrandGlyphProps {
  size?: number;
  stroke?: string;
}

/** RouteFlow building glyph — web version (uses raw SVG via dangerouslySetInnerHTML). */
export function BrandGlyph({ size = 34, stroke = "#fff" }: BrandGlyphProps) {
  const svgMarkup =
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">` +
    `<path d="M4 17L12 13L20 17M4 17L12 21L20 17M4 17V9L12 5L20 9V17M12 13V5" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    "</svg>";
  return (
    <View
      // @ts-expect-error — react-native-web accepts dangerouslySetInnerHTML on View
      dangerouslySetInnerHTML={{ __html: svgMarkup }}
      style={{ width: size, height: size }}
    />
  );
}
