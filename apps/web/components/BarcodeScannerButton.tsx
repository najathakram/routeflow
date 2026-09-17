"use client";

import * as React from "react";
import { Camera, X } from "lucide-react";
import { cn } from "@routeflow/ui/web";

interface BarcodeScannerButtonProps {
  onScan: (code: string) => void;
  /** Pass the ref of an associated text input to enable USB/physical-scanner auto-submit */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
  title?: string;
  /**
   * Called with a plain-language message whenever the webcam path can't start —
   * permission denied, no camera present, or an insecure origin (getUserMedia is
   * unavailable outside https/localhost). Optional so existing call sites keep
   * their prior (silent) behavior; new call sites should surface it (a toast,
   * an inline message) rather than leaving the operator staring at nothing.
   */
  onError?: (message: string) => void;
}

/** Maps the webcam failure modes callers actually hit to a message an operator can act on. */
function classifyScannerError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera access was denied. Allow camera access in your browser's site settings, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera was found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The camera is already in use by another app or tab.";
  }
  return "Couldn't start the camera. Check camera permissions and try again.";
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
 *    On successful decode `onScan` is called and the overlay closes.
 */
export function BarcodeScannerButton({
  onScan,
  inputRef,
  className,
  title = "Scan barcode",
  onError,
}: BarcodeScannerButtonProps) {
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const readerRef = React.useRef<any>(null);

  // ── USB / physical scanner auto-submit ──────────────────────────────────
  React.useEffect(() => {
    if (!inputRef?.current) return;
    const input = inputRef.current;

    let lastKeyTime = 0;
    let sequence = "";

    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();

      if (e.key === "Enter") {
        // If we have a barcode-length sequence that arrived fast, treat as scan
        if (sequence.length >= 6 && now - lastKeyTime < 150) {
          e.preventDefault();
          onScan(sequence);
          sequence = "";
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
  }, [inputRef, onScan]);

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
    setScannerOpen(true);
  };

  React.useEffect(() => {
    if (!scannerOpen || !videoRef.current) return;

    let active = true;

    async function init() {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        readerRef.current = reader;

        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        const deviceId = devices.length > 0 ? devices[devices.length - 1].deviceId : undefined;

        await reader.decodeFromVideoDevice(
          deviceId,
          videoRef.current!,
          (result, _err, controls) => {
            if (!active) return;
            if (result) {
              onScan(result.getText());
              controls.stop();
              setScannerOpen(false);
            }
          },
        );
      } catch (err) {
        console.error("Barcode scanner error:", err);
        if (active) onError?.(classifyScannerError(err));
        setScannerOpen(false);
      }
    }

    init();

    return () => {
      active = false;
      try {
        readerRef.current?.reset?.();
      } catch {}
    };
  }, [scannerOpen, onScan, onError]);

  const closeScanner = () => {
    try {
      readerRef.current?.reset?.();
    } catch {}
    setScannerOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={startWebcam}
        title={title}
        className={cn(
          "inline-flex items-center justify-center rounded border border-surface-border bg-white p-1.5 text-navy/70 transition hover:bg-surface-raised hover:text-navy focus:outline-none focus:ring-2 focus:ring-brand-500",
          className,
        )}
      >
        <Camera size={16} />
      </button>

      {scannerOpen && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black/90">
          <div className="relative w-full max-w-sm">
            <video ref={videoRef} className="w-full rounded-lg" autoPlay muted playsInline />
            {/* Scan guide overlay */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-32 w-64 rounded border-2 border-brand-400 opacity-80" />
            </div>
            <p className="mt-3 text-center text-sm text-white/70">Align barcode within the box</p>
          </div>
          <button
            type="button"
            onClick={closeScanner}
            className="mt-6 flex items-center gap-2 rounded-full bg-white/20 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/30"
          >
            <X size={16} />
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
