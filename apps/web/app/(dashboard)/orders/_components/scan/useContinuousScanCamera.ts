"use client";

import * as React from "react";
import type { AimBoxRect, BarcodeBoundsLike } from "@routeflow/scanning";
import { aimBoxInVideoPixels, boundsFromResultPoints } from "@/lib/scan-aim";
import {
  classifyScannerError,
  hasTorch,
  nudgeFocus,
  openCamera,
  setTorch,
} from "@/lib/scan-camera";

/**
 * The geometry of one decoded frame, for the aim-box filter (owner ruling 2026-09-24): `bounds` is the barcode's box in the
 * VIDEO FRAME's pixel space (from zxing's result points) and `aimBox` is the drawn box in that same space. Either is
 * `undefined` when it cannot be known (no result points, video not sized yet), and the filter then fails OPEN.
 */
export interface ScanFrame {
  bounds?: BarcodeBoundsLike;
  aimBox?: AimBoxRect;
}

export interface ContinuousScanCamera {
  /** Attach to the preview `<video>`. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** The platform reported a torch on this camera (never iOS Safari). */
  torchAvailable: boolean;
  torchOn: boolean;
  toggleTorch: () => void;
  /** Tap-to-refocus best effort (see `nudgeFocus`). */
  refocus: () => void;
  /** Operator-readable reason the camera could not start; null while it is fine. */
  error: string | null;
}

/**
 * The camera behind the accumulating scan screen: opens the rear camera through `openCamera()`,
 * hands the stream to zxing's `decodeFromStream`, and calls `onDetect` for EVERY decode — unlike
 * `BarcodeScannerButton`'s single-shot overlay it never stops after a hit. Repeated frames of the
 * same barcode are the scan engine's job to gate (`@routeflow/scanning`), not this hook's.
 *
 * Lifecycle rules carried from `BarcodeScannerButton` (each was a real leak or race there):
 *  - `onDetect` goes through a ref so a parent re-render never tears the stream down and reopens it;
 *  - nothing may leak when `enabled` flips off (or the screen unmounts) while `getUserMedia` or
 *    `decodeFromStream` is still pending — both are re-checked after their await;
 *  - a failed start stops any stream it had already been granted.
 */
export function useContinuousScanCamera({
  enabled,
  onDetect,
}: {
  enabled: boolean;
  onDetect: (code: string, frame: ScanFrame) => void;
}): ContinuousScanCamera {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const controlsRef = React.useRef<{ stop: () => void } | null>(null);
  const trackRef = React.useRef<MediaStreamTrack | null>(null);
  const onDetectRef = React.useRef(onDetect);
  onDetectRef.current = onDetect;
  const [torchAvailable, setTorchAvailable] = React.useState(false);
  const [torchOn, setTorchOn] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    setError(null);
    setTorchOn(false);
    setTorchAvailable(false);

    async function init() {
      let stream: MediaStream | null = null;
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          setError(
            "Camera scanning needs a secure connection (https). Enter the code manually instead.",
          );
          return;
        }
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        stream = await openCamera();
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        setTorchAvailable(hasTorch(track));

        // Steady-read (3 frames of the same value, streak gap 700 ms, absence ~800 ms) is tuned for a ~100 ms read cadence;
        // zxing's own defaults wait 500 ms after every decode AND after every miss, which would starve it (see the test).
        const reader = new BrowserMultiFormatReader(undefined, {
          delayBetweenScanSuccess: 100,
          delayBetweenScanAttempts: 100,
        });
        const controls = await reader.decodeFromStream(stream, videoRef.current!, (result) => {
          if (!active || !result) return;
          const video = videoRef.current;
          const aimBox = video
            ? aimBoxInVideoPixels({
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                clientWidth: video.clientWidth,
                clientHeight: video.clientHeight,
              })
            : null;
          onDetectRef.current(result.getText(), {
            bounds: boundsFromResultPoints(result.getResultPoints?.()),
            aimBox: aimBox ?? undefined,
          });
        });
        // Disabled/unmounted while zxing was still waiting on the preview: nothing would ever
        // stop these controls, so stop them here rather than leave the camera live.
        if (!active) controls.stop();
        else controlsRef.current = controls;
      } catch (err) {
        stream?.getTracks().forEach((t) => t.stop());
        if (active) setError(classifyScannerError(err));
      }
    }

    void init();

    return () => {
      active = false;
      try {
        controlsRef.current?.stop();
      } catch {}
      controlsRef.current = null;
      trackRef.current = null;
    };
  }, [enabled]);

  const toggleTorch = React.useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    if (await setTorch(track, next)) setTorchOn(next);
    else setTorchAvailable(false); // the capability lied — drop the control, no error toast
  }, [torchOn]);

  const refocus = React.useCallback(() => {
    void nudgeFocus(trackRef.current);
  }, []);

  return {
    videoRef,
    torchAvailable,
    torchOn,
    toggleTorch: () => void toggleTorch(),
    refocus,
    error,
  };
}
