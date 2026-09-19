/**
 * Camera acquisition for the operator web scanner. Ported from
 * `apps/mobile/components/ScanCamera.web.tsx` (`openCamera`) — same browser APIs, same reasoning:
 *
 * - The UA default (640x480) leaves roughly 6px per narrow module on a 12-digit UPC at arm's
 *   length, under every decoder's floor, so resolution is requested up front. `ideal` never
 *   throws — a UA that cannot hit 1080p30 silently downgrades.
 * - `facingMode: { ideal: "environment" }` picks the rear camera. It replaces the old
 *   "last entry of enumerateDevices()" guess, whose order is not specified.
 * - `focusMode: "continuous"` is a best-effort hint. A UA drops `advanced` entries it does not
 *   understand (iOS Safari, Firefox), so it is safe everywhere and only takes effect on
 *   Chrome/Android. iOS Safari already autofocuses continuously; there is nothing to fix there.
 * - Torch is a runtime toggle, so it is the one thing that needs `applyConstraints` after
 *   acquisition. iOS Safari reports no `torch` capability, so callers gate the button on
 *   `hasTorch()` and it simply never renders there.
 */

export const IDEAL_VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
};

const ADVANCED_FOCUS = [{ focusMode: "continuous" }] as unknown as MediaTrackConstraintSet[];

/** The degrading ladder, best first. Exported so a test can pin its order. */
export const CAMERA_ATTEMPTS: MediaStreamConstraints[] = [
  { video: { ...IDEAL_VIDEO, advanced: ADVANCED_FOCUS }, audio: false },
  { video: IDEAL_VIDEO, audio: false },
  { video: { facingMode: { ideal: "environment" } }, audio: false },
];

/**
 * Open the rear camera, degrading one step at a time so a UA that rejects the whole call over an
 * unknown constraint still gets a camera — never a worse one than the old bare `{ deviceId }`.
 * A permission or no-device error fails every rung identically, so the LAST error is rethrown for
 * `classifyScannerError` to turn into an operator-readable message.
 */
export async function openCamera(): Promise<MediaStream> {
  let lastErr: unknown;
  for (const constraints of CAMERA_ATTEMPTS) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** True when the platform exposes a torch on this track (Android/Chrome; never iOS Safari). */
export function hasTorch(track: MediaStreamTrack | null | undefined): boolean {
  const caps = track?.getCapabilities?.() as Record<string, unknown> | undefined;
  return !!caps && "torch" in caps;
}

/*
 * applyConstraints REPLACES the track's constraint set, so both helpers below re-send IDEAL_VIDEO
 * alongside their `advanced` entry — otherwise toggling the torch or tapping to refocus would let
 * the UA renegotiate to its 640x480 default, the exact condition this module exists to avoid.
 */

/**
 * Turns the torch on/off. Resolves false — never throws — when the capability object lied (a known
 * browser quirk), so the caller can quietly hide the control instead of surfacing an error.
 */
export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<boolean> {
  try {
    await track.applyConstraints({
      ...IDEAL_VIDEO,
      advanced: [{ torch: on }],
    } as unknown as MediaTrackConstraints);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort focus nudge for a tap on the preview. There is no standard point-and-focus for a
 * getUserMedia track; re-sending the continuous-focus request is documented to un-stick some
 * Android/Chrome lenses and is a harmless no-op elsewhere. Never throws.
 */
export async function nudgeFocus(track: MediaStreamTrack | null | undefined): Promise<void> {
  if (!track) return;
  try {
    await track.applyConstraints({
      ...IDEAL_VIDEO,
      advanced: ADVANCED_FOCUS,
    } as unknown as MediaTrackConstraints);
  } catch {
    // No focus control on this camera — nothing to do.
  }
}
