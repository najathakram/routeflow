import * as React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { type ScanOutcome } from "../lib/scan-loop";
import { createScanEngine, frameScanned, manualScanned, scanSettled } from "../lib/scan-engine";
import { scanFallbackContent } from "../lib/scan-fallback";
import { cueForOutcome } from "../lib/scan-feedback";
import { playScanCue, unlockScanCue } from "../lib/scan-cue";

export interface ScanCameraProps {
  onScanned: (code: string) => ScanOutcome | Promise<ScanOutcome>;
  onOutcome?: (outcome: ScanOutcome) => void;
  /**
   * Fires whenever the pending buffer's resolving state flips — lets a host
   * sheet (ScanOrderSheet) show a "looking up…" indicator instead of dead
   * frames while a scan resolves (F30 / R2, REG-B192; wired into this web
   * path as REG-B202).
   */
  onResolvingChange?: (isResolving: boolean) => void;
  active?: boolean;
  continuous?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Rendered under the help/manual-entry block, e.g. the caller's Done button. */
  footer?: React.ReactNode;
  /**
   * Show the idle help copy. Off for embedded use, where the surrounding UI
   * already explains itself. Manual entry is NOT gated on this — it is the only
   * way in when the camera streams but never decodes.
   */
  hint?: boolean;
  onModeChange?: (mode: "camera" | "manual") => void;
}

type DetectedBarcode = { rawValue: string; format?: string };

interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): {
    detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
  };
  getSupportedFormats?: () => Promise<string[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

/**
 * What a wholesale distributor actually scans. ITF-14 (`itf`) is the standard
 * outer-case barcode and was previously missing from every format list.
 */
const WANTED_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "itf",
  "qr_code",
];

/**
 * ~15 attempts/sec. The in-flight guard means the effective rate is
 * min(15fps, 1/decodeTime), so a slow device degrades instead of queueing.
 *
 * For scale: @zxing/browser's `decodeFromStream` defaults to
 * `delayBetweenScanAttempts: 500` — TWO attempts per second. zxing is the only
 * decoder on iOS (no browser there ships BarcodeDetector), so that default was
 * the single biggest cause of "the scanner isn't sensitive enough".
 */
const DETECT_INTERVAL_MS = 66;

/**
 * 640x480 (the UA default) leaves roughly 6px per narrow module on a 12-digit
 * UPC at arm's length — under every decoder's floor. `ideal` never throws, so
 * the UA silently downgrades rather than failing.
 */
const IDEAL_VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
};

/**
 * Best-effort focus. Per the mediacapture spec a UA DROPS `advanced` entries it
 * doesn't understand rather than rejecting the call, so this is safe
 * everywhere; it takes effect on Chrome/Android and is ignored on iOS Safari
 * (which autofocuses continuously anyway) and Firefox.
 */
const ADVANCED_FOCUS = [{ focusMode: "continuous" }] as unknown as MediaTrackConstraintSet[];

/**
 * Open the rear camera, degrading one step at a time so we can never end up
 * with a WORSE camera than the pre-existing bare constraint.
 */
async function openCamera(): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    { video: { ...IDEAL_VIDEO, advanced: ADVANCED_FOCUS }, audio: false },
    { video: IDEAL_VIDEO, audio: false },
    { video: { facingMode: { ideal: "environment" } }, audio: false },
  ];
  let lastErr: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Web has no OS camera permission object — getUserMedia surfaces failures
 * inline — so the native hook's `enabled` argument has nothing to gate here.
 */
export function useScanCameraPermission(): { granted: boolean; request: () => void } {
  return { granted: true, request: () => undefined };
}

export function ScanCamera({
  onScanned,
  onOutcome,
  onResolvingChange,
  active = true,
  continuous = false,
  style,
  footer,
  hint = true,
  onModeChange,
}: ScanCameraProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const trackRef = React.useRef<MediaStreamTrack | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const readerRef = React.useRef<any>(null);
  const firedRef = React.useRef(false);
  // Replaces the old drop-not-queue `busyRef` boolean plus the single-slot
  // `gateRef` (F30 / R2, REG-B192, wired into web as REG-B202): one pure
  // state machine (`lib/scan-engine.ts`) sequencing scan-loop.ts's gate and
  // scan-pending-buffer.ts's buffer, so a detection arriving mid-resolve is
  // buffered instead of silently lost.
  const engineRef = React.useRef(createScanEngine());
  // Loop state. `stopped` latches teardown, `inFlight` serialises decodes so a
  // slow frame can't queue behind itself, `lastDetect` throttles to ~15fps.
  const stoppedRef = React.useRef(false);
  const inFlightRef = React.useRef(false);
  const lastDetectRef = React.useRef(0);
  /** Set once an engine is chosen; resolves to a decoded string or null. */
  const detectOnceRef = React.useRef<null | (() => Promise<string | null>)>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [manualMode, setManualMode] = React.useState(false);
  const [manualValue, setManualValue] = React.useState("");
  const [torchOn, setTorchOn] = React.useState(false);
  const [caps, setCaps] = React.useState<{ torch: boolean }>({ torch: false });
  // Parents recreate these callbacks every render; route them through refs so
  // the handlers stay stable and the camera effect doesn't restart after each scan.
  const onScannedRef = React.useRef(onScanned);
  onScannedRef.current = onScanned;
  const onOutcomeRef = React.useRef(onOutcome);
  onOutcomeRef.current = onOutcome;
  const onResolvingChangeRef = React.useRef(onResolvingChange);
  onResolvingChangeRef.current = onResolvingChange;
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const onModeChangeRef = React.useRef(onModeChange);
  onModeChangeRef.current = onModeChange;

  React.useEffect(() => {
    onModeChangeRef.current?.(manualMode ? "manual" : "camera");
  }, [manualMode]);

  const stop = React.useCallback(() => {
    stoppedRef.current = true;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // NB: @zxing/browser's BrowserCodeReader has no `reset()` — the old call
    // here threw straight into a swallowing catch. We drive zxing frame-by-frame
    // via decodeFromCanvas now, so there is nothing to tear down but the stream.
    readerRef.current = null;
    detectOnceRef.current = null;
    trackRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  /** Torch, where the platform exposes it. Android/Chrome only — iOS Safari
   *  reports no `torch` capability in any version, so the button never renders
   *  there and there is no web workaround. */
  const toggleTorch = React.useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next }],
      } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      // The capability lied — hide the control rather than leave a dead button.
      setCaps((prev) => ({ ...prev, torch: false }));
    }
  }, [torchOn]);

  /**
   * Resolves one accepted code, then drains whatever the engine queued while
   * it was in flight — recursing (not looping) so each queued code gets its
   * own resolve/outcome cycle exactly like a fresh scan would (mirrors
   * ScanCamera.tsx's `resolveCode`). Web keeps an `outcome?.close` branch
   * native doesn't have — closing the scanner replaces it with a different
   * screen — but the drain below is UNCONDITIONAL, same as native: a close
   * must never strand a buffered code unresolved.
   *
   * The engine advances only once `onScanned` has actually SETTLED, for the
   * same reason ScanCamera.tsx's version does: the per-scan deadline that
   * keeps a slow lookup from holding this open lives in the handler itself
   * (`lib/scan-ladder`'s `SCAN_RESOLVE_TIMEOUT_MS`), where it can abort the
   * request.
   */
  const resolveCode = React.useCallback(
    async (code: string) => {
      try {
        const outcome = await onScannedRef.current(code);
        // Audible + haptic accept/reject cue (F30 / REG-B202 PR1 commit 2):
        // purely observational — `cueForOutcome` only READS the outcome
        // already destined for `onOutcomeRef` below, and `playScanCue` never
        // throws (see its header), so this can't alter what happens next.
        // Placed here, not inside the engine or scan-loop.ts, precisely so a
        // cue bug can never touch scan state.
        playScanCue(cueForOutcome(outcome));
        if (outcome?.close) stop();
        onOutcomeRef.current?.(outcome);
      } finally {
        const step = scanSettled(engineRef.current);
        engineRef.current = step.next;
        if (step.indicator) onResolvingChangeRef.current?.(step.indicator === "on");
        if (step.startResolving) void resolveCode(step.startResolving);
      }
    },
    [stop],
  );

  /**
   * One frame decoded off the continuous camera path. SYNCHRONOUS: it only
   * threads the code through the engine and starts a resolve when the engine
   * says to — nothing here is awaited, so the decode loop below can release
   * its in-flight guard the moment the DECODE settles rather than the
   * resolve, which is what let mid-resolve frames reach this at all.
   */
  const handleFrame = React.useCallback(
    (code: string) => {
      if (!activeRef.current) return;
      if (!continuous) {
        if (firedRef.current) return;
        firedRef.current = true;
        stop();
        onScannedRef.current(code);
        return;
      }
      const step = frameScanned(engineRef.current, code, Date.now());
      engineRef.current = step.next;
      if (step.indicator) onResolvingChangeRef.current?.(step.indicator === "on");
      if (step.startResolving) void resolveCode(step.startResolving);
    },
    [continuous, resolveCode, stop],
  );

  /**
   * A deliberate manual submit. Always intentional, so it SKIPS the gate —
   * unlike a camera frame it never faces a repeat-suppression cooldown — but
   * still goes through the buffer, so one arriving mid-resolve is queued
   * instead of dropped.
   */
  const handleManual = React.useCallback(
    (code: string) => {
      if (!activeRef.current) return;
      if (!continuous) {
        if (firedRef.current) return;
        firedRef.current = true;
        stop();
        onScannedRef.current(code);
        return;
      }
      const step = manualScanned(engineRef.current, code);
      engineRef.current = step.next;
      if (step.indicator) onResolvingChangeRef.current?.(step.indicator === "on");
      if (step.startResolving) void resolveCode(step.startResolving);
    },
    [continuous, resolveCode, stop],
  );

  /**
   * One throttled decode loop, whichever engine is active.
   *
   * The previous version had two structural bugs, both fatal and both silent:
   * it `return`ed on a transient `!videoRef.current` WITHOUT rescheduling
   * (killing the loop permanently), and in continuous mode after `stop()` it
   * fell through and RE-ARMED against a dead stream (a CPU-burning loop until
   * unmount). Scheduling first and latching on `stoppedRef` makes both
   * impossible.
   */
  const loop = React.useCallback(() => {
    if (stoppedRef.current) {
      rafRef.current = null;
      return;
    }
    rafRef.current = requestAnimationFrame(loop);

    if (inFlightRef.current) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - lastDetectRef.current < DETECT_INTERVAL_MS) return;

    const video = videoRef.current;
    // readyState < HAVE_CURRENT_DATA means there is no frame to decode yet.
    if (!video || video.readyState < 2) return;
    const detect = detectOnceRef.current;
    if (!detect) return;

    lastDetectRef.current = now;
    inFlightRef.current = true;
    void detect()
      .then((code) => {
        if (code) handleFrame(code);
      })
      .catch(() => undefined)
      .finally(() => {
        // Releases as soon as the DECODE settles, not the resolve — handleFrame
        // is synchronous, so this chain no longer awaits the code lookup.
        inFlightRef.current = false;
      });
  }, [handleFrame]);

  React.useEffect(() => {
    let cancelled = false;
    stoppedRef.current = false;

    const start = async () => {
      // Mounting this screen already required the operator to navigate/tap
      // into it, so this counts as "after a user gesture" for the browser's
      // autoplay policy — least-invasive spot to unlock the scan cue's
      // AudioContext, and it fires whether the camera opens or falls back to
      // manual mode (`unlockScanCue` is a safe-to-call-repeatedly no-op
      // otherwise). See `lib/scan-cue.web.ts`.
      unlockScanCue();

      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera access isn't available. Use HTTPS in Chrome or Safari.");
        setManualMode(true);
        return;
      }

      let stream: MediaStream;
      try {
        stream = await openCamera();
      } catch (e: unknown) {
        setError(friendlyCameraError(e));
        setManualMode(true);
        return;
      }

      if (cancelled) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      streamRef.current = stream;

      const track = stream.getVideoTracks()[0] ?? null;
      trackRef.current = track;
      const capabilities = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
      // getCapabilities is absent on Firefox — `caps` just stays false there.
      setCaps({ torch: "torch" in capabilities });

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play().catch(() => undefined);
      }

      // Engine 1: native BarcodeDetector (Chrome / Edge / Android).
      const Ctor = typeof window !== "undefined" ? window.BarcodeDetector : undefined;
      let usedNative = false;
      if (Ctor) {
        try {
          // Chrome on desktop Windows/Linux can expose the constructor while
          // supporting NOTHING, and constructing with an unsupported format
          // throws. Unguarded, that throw was swallowed per-frame forever and
          // zxing was never reached: a camera that streams and never decodes.
          const supported = (await Ctor.getSupportedFormats?.()) ?? [];
          const formats = WANTED_FORMATS.filter((f) => supported.includes(f));
          if (formats.length >= 3) {
            const detector = new Ctor({ formats });
            // No canvas here on purpose: detect(videoElement) lets the browser
            // hand the native frame to the platform detector. Routing it
            // through a 2D canvas forces a GPU readback and is slower with no
            // accuracy gain.
            detectOnceRef.current = async () => {
              const v = videoRef.current;
              if (!v) return null;
              const codes = await detector.detect(v);
              const hit = codes?.[0];
              if (!hit?.rawValue) return null;
              // ITF is prone to partial reads; only a full ITF-14 is trustworthy.
              if (hit.format === "itf" && hit.rawValue.length !== 14) return null;
              return hit.rawValue;
            };
            usedNative = true;
          }
        } catch {
          /* fall through to zxing */
        }
      }

      // Engine 2: zxing. The only decoder available on iOS.
      if (!usedNative) {
        try {
          const { BrowserMultiFormatReader, BarcodeFormat } = await import("@zxing/browser");
          const { DecodeHintType } = await import("@zxing/library");
          if (cancelled) return;
          const hints = new Map<number, unknown>([
            // Default hints make MultiFormatReader try Aztec, PDF417,
            // DataMatrix, MaxiCode and RSS on every attempt. Restricting to
            // what we actually sell buys most of that CPU back...
            [
              DecodeHintType.POSSIBLE_FORMATS,
              [
                BarcodeFormat.EAN_13,
                BarcodeFormat.EAN_8,
                BarcodeFormat.UPC_A,
                BarcodeFormat.UPC_E,
                BarcodeFormat.CODE_128,
                BarcodeFormat.CODE_39,
                BarcodeFormat.ITF,
                BarcodeFormat.QR_CODE,
              ],
            ],
            // ...and TRY_HARDER spends it on more scan rows plus a rotated
            // pass, so a label held vertically still reads.
            [DecodeHintType.TRY_HARDER, true],
          ]);
          const reader = new BrowserMultiFormatReader(hints as any);
          readerRef.current = reader;

          // Centre band only: 1D barcodes are wide and short, and the operator
          // centres them. Downscaled so a TRY_HARDER pass fits the frame budget
          // while still carrying far more detail than the old 640-wide frame.
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          detectOnceRef.current = async () => {
            const v = videoRef.current;
            if (!v || !v.videoWidth || !ctx) return null;
            const sw = Math.round(v.videoWidth * 0.92);
            const sh = Math.round(v.videoHeight * 0.42);
            const sx = Math.round((v.videoWidth - sw) / 2);
            const sy = Math.round((v.videoHeight - sh) / 2);
            const scale = Math.min(1, 1024 / sw);
            const dw = Math.round(sw * scale);
            const dh = Math.round(sh * scale);
            if (canvas.width !== dw || canvas.height !== dh) {
              canvas.width = dw;
              canvas.height = dh;
            }
            ctx.drawImage(v, sx, sy, sw, sh, 0, 0, dw, dh);
            try {
              const result = reader.decodeFromCanvas(canvas);
              const text = result.getText();
              const format = result.getBarcodeFormat?.();
              if (format === BarcodeFormat.ITF && text.length !== 14) return null;
              return text;
            } catch {
              // NotFoundException on every frame that doesn't contain a code.
              return null;
            }
          };
        } catch {
          if (!cancelled) {
            setError("Barcode scanning failed. Try entering the code manually.");
            setManualMode(true);
          }
          return;
        }
      }

      if (cancelled) return;
      rafRef.current = requestAnimationFrame(loop);
    };

    void start();

    return () => {
      cancelled = true;
      stop();
    };
  }, [loop, stop]);

  const submitManual = () => {
    const trimmed = manualValue.trim();
    if (!trimmed) return;
    handleManual(trimmed);
    if (continuous) setManualValue("");
  };

  // The card always carries a way into manual entry, so it always renders.
  const card = scanFallbackContent({ hint, manualMode, hasError: error != null });
  // Holding nothing but the escape-hatch link (embedded scanner, camera fine):
  // shrink to stay out of the operator's view of the barcode.
  const linkOnlyCard = !card.showError && !card.showHelp && !card.showManualInput && footer == null;

  return (
    <View style={[styles.root, style]}>
      {!manualMode ? (
        <video
          ref={videoRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            backgroundColor: "#000",
          }}
          muted
          autoPlay
          playsInline
        />
      ) : (
        <View style={styles.manualBg} />
      )}

      <View style={styles.overlay} pointerEvents="box-none">
        {/* Android/Chrome only — iOS Safari exposes no torch capability, so
            this simply doesn't render on iPhone. */}
        {!manualMode && caps.torch ? (
          <Pressable
            onPress={() => void toggleTorch()}
            style={[styles.torchBtn, torchOn && styles.torchBtnOn]}
            accessibilityRole="button"
            accessibilityLabel={torchOn ? "Turn off the light" : "Turn on the light"}
            accessibilityState={{ selected: torchOn }}
          >
            <Text style={styles.torchText}>{torchOn ? "Light on" : "Light"}</Text>
          </Pressable>
        ) : null}

        <View style={[styles.bottomCard, linkOnlyCard && styles.bottomCardCompact]}>
          {card.showError ? (
            <Text style={styles.error}>{error}</Text>
          ) : card.showHelp ? (
            <Text style={styles.help}>
              {manualMode
                ? "Enter the barcode or SKU manually."
                : continuous
                  ? "Scan items one after another — tap Done when finished."
                  : "Align barcode within the box."}
            </Text>
          ) : null}

          {card.showManualInput ? (
            <View style={styles.manualRow}>
              <TextInput
                value={manualValue}
                onChangeText={setManualValue}
                placeholder="Type SKU or barcode"
                placeholderTextColor="rgba(255,255,255,0.5)"
                autoFocus
                style={styles.manualInput}
                onSubmitEditing={submitManual}
              />
              <Pressable
                onPress={submitManual}
                style={[styles.manualBtn, !manualValue.trim() && styles.manualBtnDisabled]}
                disabled={!manualValue.trim()}
              >
                <Text style={styles.manualBtnText}>Use</Text>
              </Pressable>
            </View>
          ) : card.showManualLink ? (
            <Pressable
              onPress={() => {
                stop();
                setManualMode(true);
              }}
              style={styles.linkBtn}
              accessibilityRole="button"
              accessibilityLabel="Enter code manually"
            >
              <Text style={styles.linkText}>
                {card.showHelp ? "Or enter code manually" : "Enter code manually"}
              </Text>
            </Pressable>
          ) : null}

          {footer}
        </View>
      </View>
    </View>
  );
}

function friendlyCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera access was blocked. Tap the lock/camera icon in your browser's address bar, allow the camera for this site, then try again. (If you added the app to your home screen, grant the camera there too.)";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is in use by another app. Close it and try again.";
    case "OverconstrainedError":
      return "Couldn't open the rear camera on this device.";
    case "SecurityError":
      return "The camera needs a secure (https) connection.";
    default:
      return (err as { message?: string })?.message || "Unable to start the camera.";
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  manualBg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#101014" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  bottomCard: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 28,
    padding: 18,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.78)",
    gap: 12,
  },
  bottomCardCompact: { paddingVertical: 2, paddingHorizontal: 12, gap: 6 },
  help: {
    color: "#fff",
    fontSize: 14,
    textAlign: "center",
  },
  error: {
    color: "#ff8a80",
    fontSize: 13,
    textAlign: "center",
  },
  manualRow: { flexDirection: "row", gap: 10 },
  manualInput: {
    flex: 1,
    color: "#fff",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    fontSize: 15,
  },
  manualBtn: {
    paddingHorizontal: 18,
    justifyContent: "center",
    backgroundColor: "#3b82f6",
    borderRadius: 10,
  },
  manualBtnDisabled: { opacity: 0.5 },
  manualBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  linkBtn: { alignItems: "center", justifyContent: "center", minHeight: 44 },
  linkText: { color: "rgba(255,255,255,0.85)", fontSize: 13 },
  torchBtn: {
    position: "absolute",
    left: 16,
    // Clear of the bottom card (compact ~44px + 28px inset) and of the pills
    // the host sheet puts along the top edge.
    bottom: 84,
    minHeight: 44,
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  torchBtnOn: { backgroundColor: "rgba(255,214,10,0.92)" },
  torchText: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
