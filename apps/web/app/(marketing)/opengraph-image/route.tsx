import { ImageResponse } from "next/og";
import { SHARE_IMAGE, SHARE_IMAGE_LINES } from "../lib/metadata";

// The share image, drawn by code so no binary goes in git (W8). Words: COPY.md section 8.
// A route handler rather than Next's `opengraph-image.tsx` file convention: see SHARE_IMAGE.
export const dynamic = "force-static";

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
        background: "#0E1F36",
        color: "#F7F3EA",
      }}
    >
      <div style={{ width: 96, height: 8, background: "#4A8F82", marginBottom: 40 }} />
      <div style={{ fontSize: 132, fontWeight: 700, letterSpacing: -3, lineHeight: 1.05 }}>
        {SHARE_IMAGE_LINES.name}
      </div>
      <div style={{ fontSize: 44, marginTop: 28, lineHeight: 1.25, color: "#D9E3EE" }}>
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
