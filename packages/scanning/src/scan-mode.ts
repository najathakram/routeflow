/**
 * Scanner mode (owner ruling 2026-09-24, see project memory
 * `project_scan_aimbox_hold_to_scan_2026-09-24`): OPTIONAL per-device toggle —
 * "Continuous" (default; every accepted frame decodes) or "Hold to scan" (a big
 * bottom-center button; the camera stays live, but a decode is ignored unless the button
 * is held). The toggle and the button are UI; this is the one pure decision both reduce
 * to, kept testable the same way as the rest of this package.
 */
export type ScanMode = "continuous" | "hold";

/**
 * Whether a decoded frame should be acted on at all — the FIRST gate a frame passes
 * through, ahead of the aim box and steady-read checks (which have no reason to run at
 * all while the operator isn't even trying to scan in Hold mode).
 */
export function shouldDecode(mode: ScanMode, holding: boolean): boolean {
  return mode === "continuous" || holding;
}
