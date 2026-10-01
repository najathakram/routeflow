/**
 * Scanner aim box (owner ruling 2026-09-24, see project memory
 * `project_scan_aimbox_hold_to_scan_2026-09-24`): DEFAULT ON — only a barcode decoded
 * INSIDE a center aim box counts as a candidate scan. Most accidental reads come from
 * off-center codes and passing glances, which this fixes at no cost to a deliberate scan.
 *
 * UNITS ARE NOT NORMALIZED. expo-camera's own `BarcodeScanningResult.bounds` is reported
 * "in the coordinate space of the camera source... adjusted to the dimensions of the
 * view" — i.e. view-relative pixels matching the `CameraView`'s own rendered size, never
 * 0..1. The aim box the caller passes in must be in that SAME pixel space (the camera
 * view's own layout width/height), so this module takes plain rects and does no scaling
 * of its own.
 */

export interface AimBoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The subset of expo-camera's `BarcodeBounds` shape this module actually reads. */
export interface BarcodeBoundsLike {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * True when `bounds`' CENTER point falls inside `aimBox`. Center, not full containment:
 * expo-camera's own docs warn `bounds` "doesn't have to bound the whole barcode" — a
 * strict full-containment check would reject a valid read whose reported box undershoots
 * the physical code.
 *
 * FAIL-OPEN (returns `true`) when `bounds` is missing or degenerate (zero width/height).
 * expo-camera's docs also warn `bounds` "in some cases will represent an empty rectangle,"
 * and some platform/symbology combinations (iOS `code39`/`pdf417`) report no geometry at
 * all. A device or symbology that can never satisfy a fail-CLOSED check would silently
 * lose scanning entirely — worse than the accidental-read problem the aim box exists to
 * fix — so the absence of geometry is treated as "can't tell, allow it," not "reject it."
 */
export function isWithinAimBox(
  bounds: BarcodeBoundsLike | null | undefined,
  aimBox: AimBoxRect,
): boolean {
  if (!bounds) return true;
  const { width, height } = bounds.size;
  if (!(width > 0) || !(height > 0)) return true;
  const cx = bounds.origin.x + width / 2;
  const cy = bounds.origin.y + height / 2;
  return (
    cx >= aimBox.x &&
    cx <= aimBox.x + aimBox.width &&
    cy >= aimBox.y &&
    cy <= aimBox.y + aimBox.height
  );
}
