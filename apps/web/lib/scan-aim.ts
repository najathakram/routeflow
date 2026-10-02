import type { AimBoxRect, BarcodeBoundsLike } from "@routeflow/scanning";

/**
 * The web phone scanner's aim box (owner ruling 2026-09-24, DEFAULT ON): ONE centered box, the same one the camera strip
 * already DRAWS (`ScanOrderScreen`: `h-3/5 w-5/6`). Only a barcode whose centre is inside it counts; the drawing and the
 * enforcement share these fractions, pinned by a source test.
 */
export const AIM_BOX_FRACTION = { width: 5 / 6, height: 3 / 5 } as const;

export interface VideoGeometry {
  /** The decoded frame's own pixel size. */
  videoWidth: number;
  videoHeight: number;
  /** The on-screen size of the `<video>` element. */
  clientWidth: number;
  clientHeight: number;
}

/**
 * The drawn box, in the VIDEO FRAME's pixel space (the space zxing's result points live in). The preview is `object-cover`:
 * the frame is scaled by max(elW/vw, elH/vh) and the overflow cropped evenly, so the visible window is smaller than the
 * frame; the box is the centered fraction of THAT window. Returns null when either size is not known yet: no geometry means
 * no aim-box filtering (fail OPEN, never an invisible enforced rect).
 */
export function aimBoxInVideoPixels(g: VideoGeometry): AimBoxRect | null {
  const { videoWidth: vw, videoHeight: vh, clientWidth: cw, clientHeight: ch } = g;
  if (!(vw > 0) || !(vh > 0) || !(cw > 0) || !(ch > 0)) return null;
  const scale = Math.max(cw / vw, ch / vh);
  const visibleW = cw / scale;
  const visibleH = ch / scale;
  const width = visibleW * AIM_BOX_FRACTION.width;
  const height = visibleH * AIM_BOX_FRACTION.height;
  return { x: (vw - width) / 2, y: (vh - height) / 2, width, height };
}

/** zxing's `ResultPoint` (only the accessors we read). */
export interface ResultPointLike {
  getX(): number;
  getY(): number;
}

/**
 * The bounding box of zxing's result points as the `BarcodeBoundsLike` the shared aim-box check reads. No points is
 * `undefined` (the check then fails OPEN, same as a native platform that reports no geometry). A 1D barcode yields points on
 * ONE scan line (zero height): the shared check treats a zero-size rect as "no geometry" and would accept the code anywhere,
 * so each side is padded to at least 1px, keeping the CENTRE (what the check reads) exactly where the points are.
 */
export function boundsFromResultPoints(
  points: readonly ResultPointLike[] | null | undefined,
): BarcodeBoundsLike | undefined {
  if (!points || points.length === 0) return undefined;
  const xs = points.map((p) => p.getX());
  const ys = points.map((p) => p.getY());
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(Math.max(...xs) - x, 1);
  const height = Math.max(Math.max(...ys) - y, 1);
  return {
    origin: {
      x: x - (width - (Math.max(...xs) - x)) / 2,
      y: y - (height - (Math.max(...ys) - y)) / 2,
    },
    size: { width, height },
  };
}
