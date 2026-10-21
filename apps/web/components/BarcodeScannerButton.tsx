"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Camera, X, Zap, ZapOff } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import {
  classifyScannerError,
  hasTorch,
  nudgeFocus,
  openCamera,
  setTorch,
} from "@/lib/scan-camera";
import { playScanCue, unlockScanCue } from "@/lib/scan-cue";

interface BarcodeScannerButtonProps {
  /** `source` is "field" when a wedge/USB scanner typed the code into `inputRef` (the caller clears the field). */
  onScan: (code: string, source?: "field") => void;
  /** Pass the ref of an associated text input to enable USB/physical-scanner auto-submit */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
  title?: string;
  /** Disables the camera button (a wedge scanner on `inputRef` is unaffected). Pair it with `ariaLabel` to say why. */
  disabled?: boolean;
  /** Overrides the button's accessible name (otherwise `title` names it), e.g. to carry the reason it is disabled. */
  ariaLabel?: string;
  /**
   * Called with a plain-language message whenever the webcam path can't start —
   * permission denied, no camera present, or an insecure origin (getUserMedia is
   * unavailable outside https/localhost). Optional so existing call sites keep
   * their prior (silent) behavior; new call sites should surface it (a toast,
   * an inline message) rather than leaving the operator staring at nothing.
   */
  onError?: (message: string) => void;
  /**
   * When given, tapping the camera button calls this INSTEAD of opening the single-shot overlay —
   * the caller (CreateOrderModal behind `scan_v2`) renders its own accumulating scan screen. The
   * secure-context check still runs first, and the USB/wedge-scanner path is unaffected.
   */
  onOpenContinuous?: () => void;
}

/**
 * Two-mode barcode scanner for the operator web app:
 *
 * 1. USB / physical scanner — when `inputRef` is provided, attaches a keydown listener.
 *    If the input receives 8–14 chars within 150 ms then Enter, it treats the sequence
 *    as a barcode scan and calls `onScan`.  No camera is required.
 *
 * 2. Webcam — the camera icon button opens a fullscreen overlay that uses the browser's
 *    MediaDevices API + @zxing/browser BrowserMultiFormatReader to decode barcodes.
 *    On successful decode `onScan` is called (once) and the overlay closes. The camera is
 *    opened through `openCamera()` (rear camera, 1080p, continuous-focus hint) and the
 *    resulting stream is handed to zxing — see `lib/scan-camera.ts` for why.
 */
export function BarcodeScannerButton({
  onScan,
  inputRef,
  className,
  title = "Scan barcode",
  disabled,
  ariaLabel,
  onError,
  onOpenContinuous,
}: BarcodeScannerButtonProps) {
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [torchAvailable, setTorchAvailable] = React.useState(false);
  const [torchOn, setTorchOn] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const controlsRef = React.useRef<{ stop: () => void } | null>(null);
  const trackRef = React.useRef<MediaStreamTrack | null>(null);
  // Parents recreate these callbacks every render; routing them through refs keeps the camera
  // effect from tearing the stream down and reopening it whenever the parent re-renders.
  const onScanRef = React.useRef(onScan);
  onScanRef.current = onScan;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  // ── USB / physical scanner auto-submit ──────────────────────────────────
  // B672: every real caller passes `onScan` as a fresh inline closure (e.g.
  // `onScan={(code) => ...}`), recreated on every one of the PARENT's own re-renders — and the
  // parent always re-renders on every keystroke of a controlled search input. Depending on
  // `onScan` directly (as this effect used to) tore the listener down and rebuilt it (wiping
  // `sequence`) on EVERY character, so a real wedge scanner could never reach the 6-char length
  // gate below. Routed through `onScanRef` instead — same fix the camera path already uses one
  // effect down, for the identical reason ("parents recreate these callbacks every render").
  React.useEffect(() => {
    if (!inputRef?.current) return;
    const input = inputRef.current;

    let lastKeyTime = 0;
    let sequence = "";

    const handleKeyDown = (e: KeyboardEvent) => {
      // The browser's own event time, not Date.now() at handling time: a long task (a render, a lookup
      // landing) delays HANDLING of queued keys, which made a fast burst look like slow typing and cut
      // the sequence short.
      const now = e.timeStamp;

      if (e.key === "Enter") {
        // If we have a barcode-length sequence that arrived fast, treat as scan. The code is taken and the
        // sequence emptied in ONE step, before anything else can run.
        if (sequence.length >= 6 && now - lastKeyTime < 150) {
          const code = sequence;
          sequence = "";
          lastKeyTime = 0;
          e.preventDefault();
          onScanRef.current(code, "field");
        }
        return;
      }

      if (e.key.length === 1) {
        if (now - lastKeyTime > 200) {
          // Gap too long — reset (user is typing normally)
          sequence = e.key;
        } else {
          sequence += e.key;
        }
        lastKeyTime = now;
      }
    };

    input.addEventListener("keydown", handleKeyDown);
    return () => input.removeEventListener("keydown", handleKeyDown);
  }, [inputRef]);

  // ── Webcam scanner ───────────────────────────────────────────────────────
  const startWebcam = async () => {
    // getUserMedia requires a secure context (https, or localhost) — check before opening
    // the overlay at all so the operator gets an immediate, specific message instead of a
    // black video panel that silently fails a moment later.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      onError?.(
        "Camera scanning needs a secure connection (https). Type the SKU instead, or open this page over https.",
      );
      return;
    }
    // The tap that opens the scanner is the user gesture browsers require before audio can play,
    // so unlock the cue's AudioContext now rather than on the first (silent) scan.
    unlockScanCue();
    if (onOpenContinuous) {
      onOpenContinuous();
      return;
    }
    setTorchOn(false);
    setTorchAvailable(false);
    setScannerOpen(true);
  };

  React.useEffect(() => {
    if (!scannerOpen || !videoRef.current) return;

    let active = true;
    // zxing can deliver a second decode before `stop()` takes effect; only the first counts.
    let settled = false;

    async function init() {
      let stream: MediaStream | null = null;
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        stream = await openCamera();
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        setTorchAvailable(hasTorch(track));

        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(
          stream,
          videoRef.current!,
          (result, _err, cbControls) => {
            if (!active || settled || !result) return;
            settled = true;
            playScanCue("accepted");
            // zxing's scan loop starts synchronously inside decodeFromStream, so a hit can land
            // BEFORE that promise resolves and `controls` exists. The callback's own controls
            // argument is always live; using it means the camera stops on this path too.
            cbControls.stop();
            setScannerOpen(false);
            onScanRef.current(result.getText());
          },
        );
        // Cancel / unmount / route change can land while decodeFromStream is still awaiting the
        // preview (zxing waits up to 5s for the video to play). Nothing would ever stop these
        // controls, so stop them here rather than leave the camera live behind a closed overlay.
        if (!active) controls.stop();
        else controlsRef.current = controls;
      } catch (err) {
        stream?.getTracks().forEach((t) => t.stop());
        console.error("Barcode scanner error:", err);
        if (active) onErrorRef.current?.(classifyScannerError(err));
        setScannerOpen(false);
      }
    }

    init();

    return () => {
      active = false;
      try {
        controlsRef.current?.stop();
      } catch {}
      controlsRef.current = null;
      trackRef.current = null;
    };
  }, [scannerOpen]);

  const closeScanner = () => {
    try {
      controlsRef.current?.stop();
    } catch {}
    setScannerOpen(false);
  };

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    if (await setTorch(track, next)) setTorchOn(next);
    else setTorchAvailable(false); // the capability lied — drop the control, no error toast
  };

  return (
    <>
      <button
        type="button"
        onClick={startWebcam}
        title={title}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center justify-center rounded border border-surface-border bg-white p-1.5 text-navy/70 transition hover:bg-surface-raised hover:text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-navy/40 disabled:hover:text-navy/40",
          className,
        )}
      >
        <Camera size={16} />
      </button>

      {scannerOpen &&
        createPortal(
          <div className="pointer-events-auto fixed inset-0 z-[9999] flex flex-col items-center bg-black/90 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
            <div className="flex w-full max-w-md items-center justify-between">
              <button
                type="button"
                onClick={closeScanner}
                className="flex items-center gap-2 rounded-full bg-white/20 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/30"
              >
                <X size={16} />
                Cancel
              </button>
              {torchAvailable && (
                <button
                  type="button"
                  onClick={toggleTorch}
                  aria-pressed={torchOn}
                  aria-label={torchOn ? "Turn flashlight off" : "Turn flashlight on"}
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full text-white transition",
                    torchOn ? "bg-brand-500" : "bg-white/20 hover:bg-white/30",
                  )}
                >
                  {torchOn ? <Zap size={18} /> : <ZapOff size={18} />}
                </button>
              )}
            </div>
            {/* Compact landscape viewfinder: a barcode is held wide-and-short, so the preview is a
              strip (object-cover crops the frame for display only — zxing still reads all of it). */}
            <div className="relative mt-4 h-40 w-full max-w-md overflow-hidden rounded-lg sm:h-52">
              <video
                ref={videoRef}
                className="h-full w-full cursor-pointer object-cover"
                autoPlay
                muted
                playsInline
                onClick={() => void nudgeFocus(trackRef.current)}
              />
              {/* Scan guide overlay */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-3/5 w-5/6 rounded border-2 border-brand-400 opacity-80" />
              </div>
            </div>
            <p className="mt-3 text-center text-sm text-white/70">Align barcode within the box</p>
          </div>,
          document.body,
        )}
    </>
  );
}
