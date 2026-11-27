import { ImageResponse } from "next/og";
import { loadPalette } from "@routeflow/types/brand";
import { SHARE_IMAGE, SHARE_IMAGE_LINES } from "../lib/metadata";

// The share image, drawn by code so no binary goes in git (W8). Words: COPY.md section 8.
// A route handler rather than Next's `opengraph-image.tsx` file convention: see SHARE_IMAGE.
export const dynamic = "force-static";

/** The share image's colours come from the palette (packages/types/brand/palette.json), never typed. */
function colour(key: string): string {
  const value = loadPalette().color[key];
  if (!value) throw new Error(`opengraph-image: the palette has no "${key}" colour`);
  return value;
}

export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 96px",
        background: colour("ink"),
        color: colour("white"),
      }}
    >
      <div style={{ width: 96, height: 8, background: colour("copper-light"), marginBottom: 40 }} />
      <div style={{ fontSize: 132, fontWeight: 700, letterSpacing: -3, lineHeight: 1.05 }}>
        {SHARE_IMAGE_LINES.name}
      </div>
      <div style={{ fontSize: 44, marginTop: 28, lineHeight: 1.25, color: colour("bone") }}>
        {SHARE_IMAGE_LINES.line}
      </div>
    </div>,
    {
      width: SHARE_IMAGE.width,
      height: SHARE_IMAGE.height,
      // The URL carries no content hash, so cache for a day, not Next's one-year immutable.
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" },
    },
  );
}
