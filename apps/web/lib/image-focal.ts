/**
 * Focal point encoded in image keys/URLs.
 *
 * Image keys look like  `products/<productId>/<uuid>-fp50x40.jpg`
 * meaning the focal point is at 50% across, 40% down. Both values are
 * integers 0..100. Old keys without the `-fp<X>x<Y>` suffix default to
 * the centre (50, 50), so existing uploads keep working unchanged.
 *
 * Storing the focal in the filename means no DB migration: the API just
 * generates a key that includes the focal, and the frontend recovers
 * the focal from the URL StorageService hands back. To re-set a focal
 * point you re-upload the image (the page's CropModal flow handles this).
 */

export interface FocalPoint {
  /** 0..100 — percentage across the image from the LEFT edge. */
  x: number;
  /** 0..100 — percentage down the image from the TOP edge. */
  y: number;
}

export const CENTER_FOCAL: FocalPoint = { x: 50, y: 50 };

/** Pattern matched against the basename (no directory). */
const FOCAL_RE = /-fp(\d{1,3})x(\d{1,3})(?=\.[A-Za-z0-9]+$)/;

/**
 * Extract the focal point from any image URL or storage key.
 * Handles signed URLs (`?expires=&sig=...`) by parsing the path component
 * only, and falls back to {50, 50} for any URL that can't be parsed.
 */
export function parseFocalPoint(urlOrKey: string | null | undefined): FocalPoint {
  if (!urlOrKey) return CENTER_FOCAL;

  // Strip query string + take basename
  const beforeQuery = urlOrKey.split("?")[0] ?? "";
  const basename = beforeQuery.substring(beforeQuery.lastIndexOf("/") + 1);

  const match = FOCAL_RE.exec(basename);
  if (!match) return CENTER_FOCAL;

  const x = clampPct(parseInt(match[1], 10));
  const y = clampPct(parseInt(match[2], 10));
  return { x, y };
}

/** CSS `object-position` value for a focal point. */
export function focalToObjectPosition(focal: FocalPoint): string {
  return `${focal.x}% ${focal.y}%`;
}

/** Convenience: parse + format in one go. */
export function objectPositionForUrl(urlOrKey: string | null | undefined): string {
  return focalToObjectPosition(parseFocalPoint(urlOrKey));
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 50;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}
