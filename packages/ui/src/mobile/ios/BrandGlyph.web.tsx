import React from "react";

export interface BrandGlyphProps {
  size?: number;
  color?: string;
  stroke?: string;
}

/** RouteFlow route-connector glyph — web/PWA version.
 * Uses React.createElement("svg") so the SVG renders as a real DOM element,
 * matching the native react-native-svg version visually.
 */
export function BrandGlyph({ size = 34, color = "#fff", stroke }: BrandGlyphProps) {
  const c = stroke ?? color;
  const accent = "#2563EB";
  const inner =
    `<path d="M7.5 7 C5 13 19 11 16.5 17" stroke="${c}" stroke-width="2" stroke-linecap="round" opacity="0.45"/>` +
    `<circle cx="7.5" cy="7" r="3.5" fill="${c}"/>` +
    `<circle cx="7.5" cy="7" r="1.8" fill="${accent}"/>` +
    `<circle cx="16.5" cy="17" r="3.5" stroke="${accent}" stroke-width="2" fill="none"/>` +
    `<circle cx="16.5" cy="17" r="1.8" fill="${c}"/>`;
  return React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    style: { display: "block" },
    dangerouslySetInnerHTML: { __html: inner },
  });
}
