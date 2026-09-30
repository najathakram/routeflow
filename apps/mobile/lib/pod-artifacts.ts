/**
 * Pure helpers for durable proof-of-delivery artifacts.
 *
 * The signature is captured as stroke vectors (SignaturePad) and rendered here
 * to a standalone SVG data URL — pure string building, so native needs no
 * canvas or native module and web/native share one code path. It rides the
 * complete-stop JSON payload (a few KB, safe for the offline queue); the
 * server rasterizes it to a real image at ingest and stores only the raster
 * (SVG is never stored/served — deliberate upload XSS control).
 *
 * Photos are uploaded as individual JSON attaches (`POST
 * /route-runs/:id/stops/:stopId/pod-artifact`) — JSON because FormData
 * requests are excluded from the offline queue. `podPhotoArtifactId` gives
 * each photo a stable id so a queue replay whose response was lost
 * re-attaches idempotently instead of duplicating the photo.
 */

export type SignaturePoint = { x: number; y: number };
export type SignatureStroke = SignaturePoint[];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 for ASCII input (no Buffer/btoa on React Native — hand-rolled). */
export function asciiToBase64(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i);
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b) ? "=" : B64[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? "=" : B64[c & 63];
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Render captured strokes to an SVG data URL, or null when nothing drawable
 * was captured (single-point taps don't count as a signature). White
 * background baked in so the server-side raster never needs flattening.
 */
export function strokesToSvgDataUrl(
  strokes: SignatureStroke[],
  width: number,
  height: number,
): string | null {
  const drawable = strokes.filter((s) => s.length >= 2);
  if (drawable.length === 0) return null;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const paths = drawable
    .map((stroke) => {
      const d = stroke
        .map((p, i) => `${i === 0 ? "M" : "L"}${round1(p.x)} ${round1(p.y)}`)
        .join(" ");
      return `<path d="${d}" fill="none" stroke="#1e293b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#ffffff"/>${paths}</svg>`;
  return `data:image/svg+xml;base64,${asciiToBase64(svg)}`;
}

/**
 * Stable, key-safe artifact id for one captured photo (djb2 over the data
 * URL + length suffix). Stable across close-stop retries so the server's
 * per-artifactId idempotency guard can dedupe replays; collisions only
 * matter within a single stop's ≤3 photos.
 */
export function podPhotoArtifactId(dataUrl: string): string {
  let hash = 5381;
  for (let i = 0; i < dataUrl.length; i++) {
    hash = ((hash << 5) + hash + dataUrl.charCodeAt(i)) >>> 0;
  }
  return `p${hash.toString(36)}x${(dataUrl.length % 46656).toString(36)}`.padEnd(8, "0");
}
