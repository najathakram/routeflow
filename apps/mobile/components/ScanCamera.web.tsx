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
import { gateScan, type ScanGateState, type ScanOutcome } from "../lib/scan-loop";
import { scanFallbackContent } from "../lib/scan-fallback";

export interface ScanCameraProps {
  onScanned: (code: string) => ScanOutcome | Promise<ScanOutcome>;
  onOutcome?: (outcome: ScanOutcome) => void;
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

type DetectedBarcode = { rawValue: string };

interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): {
    detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
  };
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
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
  active = true,
  continuous = false,
  style,
  footer,
  hint = true,
  onModeChange,
}: ScanCameraProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const readerRef = React.useRef<any>(null);
  const firedRef = React.useRef(false);
  const gateRef = React.useRef<ScanGateState | null>(null);
  const busyRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [manualMode, setManualMode] = React.useState(false);
  const [manualValue, setManualValue] = React.useState("");
  // Parents recreate these callbacks every render; route them through refs so
  // `fire` stays stable and the camera effect doesn't restart after each scan.
  const onScannedRef = React.useRef(onScanned);
  onScannedRef.current = onScanned;
  const onOutcomeRef = React.useRef(onOutcome);
  onOutcomeRef.current = onOutcome;
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const onModeChangeRef = React.useRef(onModeChange);
  onModeChangeRef.current = onModeChange;

  React.useEffect(() => {
    onModeChangeRef.current?.(manualMode ? "manual" : "camera");
  }, [manualMode]);

  const stop = React.useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (readerRef.current) {
      try {
        readerRef.current.reset();
      } catch {
        /* ignore */
      }
      readerRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  /**
   * One decoded code from any source (BarcodeDetector, zxing, manual input).
   * `deliberate` skips the repeat-gate (manual submits are always intentional).
   */
  const fire = React.useCallback(
    async (code: string, deliberate = false) => {
      if (!activeRef.current) return;
      if (!continuous) {
        if (firedRef.current) return;
        firedRef.current = true;
        stop();
        onScannedRef.current(code);
        return;
      }
      if (busyRef.current) return;
      if (!deliberate) {
        const gated = gateScan(code, gateRef.current, Date.now());
        gateRef.current = gated.state;
        if (!gated.accept) return;
      }
      busyRef.current = true;
      try {
        const outcome = await onScannedRef.current(code);
        if (outcome?.close) stop();
        onOutcomeRef.current?.(outcome);
      } finally {
        // While onScanned was awaited, detections short-circuited at the busyRef
        // guard (or the BarcodeDetector tick was blocked on the await) WITHOUT
        // calling gateScan, so the sliding window's lastAt stayed frozen at
        // scan-start. If the lookup outran the cooldown, the next detection of
        // the SAME code would be re-accepted → double-add. Re-anchor the
        // cooldown to completion so a held item can't re-add until it leaves the
        // frame for a full window; a different code still differs and is accepted.
        gateRef.current = { lastCode: code, lastAt: Date.now() };
        busyRef.current = false;
      }
    },
    [continuous, stop],
  );

  React.useEffect(() => {
    let cancelled = false;

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera access isn't available. Use HTTPS in Chrome or Safari.");
        setManualMode(true);
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
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

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play().catch(() => undefined);
      }

      // Try native BarcodeDetector first (Chrome / Edge / Android)
      const Ctor = typeof window !== "undefined" ? window.BarcodeDetector : undefined;
      if (Ctor) {
        const detector = new Ctor({
          formats: ["ean_13", "ean_8", "code_128", "qr_code", "upc_a", "upc_e", "code_39"],
        });
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes && codes.length > 0 && codes[0]?.rawValue) {
              await fire(codes[0].rawValue);
              // Single-shot: fire() latched + stopped — end the loop.
              if (firedRef.current) return;
            }
          } catch {
            /* ignore per-frame errors */
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Fallback: use @zxing/browser (works on Safari / Firefox / iOS)
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (cancelled) return;
        const reader = new BrowserMultiFormatReader();
        readerRef.current = reader;
        const videoEl = videoRef.current;
        if (!videoEl) return;
        reader.decodeFromStream(stream, videoEl, (result, err) => {
          if (cancelled) return;
          if (result) {
            void fire(result.getText());
          } else if (err && (err as any).name !== "NotFoundException") {
            // real error, ignore transient "not found" per-frame errors
          }
        });
      } catch (e: unknown) {
        if (!cancelled) {
          setError("Barcode scanning failed. Try entering the code manually.");
          setManualMode(true);
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      stop();
    };
  }, [fire, stop]);

  const submitManual = () => {
    const trimmed = manualValue.trim();
    if (!trimmed) return;
    void fire(trimmed, true);
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
});
