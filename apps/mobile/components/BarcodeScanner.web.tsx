import * as React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { gateScan, ScanGateState, ScanOutcome, ScanFeedback } from "../lib/scan-loop";

interface Props {
  /**
   * Called with each accepted code. In `continuous` mode the (possibly async)
   * return value drives the overlay: `{feedback}` shows a banner and keeps
   * scanning, `{close:true}` closes via `onClose`.
   */
  onScanned: (code: string) => ScanOutcome | Promise<ScanOutcome>;
  onClose: () => void;
  /** Keep the camera open after a scan so the operator can scan the next item. */
  continuous?: boolean;
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

export function BarcodeScanner({ onScanned, onClose, continuous = false }: Props) {
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
  const [feedback, setFeedback] = React.useState<ScanFeedback | null>(null);
  const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Parents recreate these callbacks every render; route them through refs so
  // `fire` stays stable and the camera effect doesn't restart after each scan.
  const onScannedRef = React.useRef(onScanned);
  onScannedRef.current = onScanned;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

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

  const showFeedback = React.useCallback((fb: ScanFeedback) => {
    setFeedback(fb);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2500);
  }, []);

  React.useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );

  /**
   * One decoded code from any source (BarcodeDetector, zxing, manual input).
   * `deliberate` skips the repeat-gate (manual submits are always intentional).
   */
  const fire = React.useCallback(
    async (code: string, deliberate = false) => {
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
        if (outcome?.close) {
          stop();
          onCloseRef.current();
          return;
        }
        if (outcome?.feedback) showFeedback(outcome.feedback);
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
    [continuous, stop, showFeedback],
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

  const handleClose = () => {
    stop();
    onClose();
  };

  const submitManual = () => {
    const trimmed = manualValue.trim();
    if (!trimmed) return;
    void fire(trimmed, true);
    if (continuous) setManualValue("");
  };

  return (
    <View style={StyleSheet.absoluteFill}>
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
        {feedback ? (
          <View style={[styles.feedback, feedback.kind === "error" && styles.feedbackError]}>
            <Ionicons
              name={feedback.kind === "added" ? "checkmark-circle" : "alert-circle"}
              size={18}
              color="#fff"
            />
            <Text style={styles.feedbackText} numberOfLines={2}>
              {feedback.text}
            </Text>
          </View>
        ) : null}

        {!manualMode ? <View style={styles.scanWindow} pointerEvents="none" /> : null}

        <View style={styles.bottomCard}>
          {error ? (
            <Text style={styles.error}>{error}</Text>
          ) : (
            <Text style={styles.help}>
              {manualMode
                ? "Enter the barcode or SKU manually."
                : continuous
                  ? "Scan items one after another — tap Done when finished."
                  : "Align barcode within the box."}
            </Text>
          )}

          {manualMode ? (
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
          ) : (
            <Pressable
              onPress={() => {
                stop();
                setManualMode(true);
              }}
              style={styles.linkBtn}
            >
              <Text style={styles.linkText}>Or enter code manually</Text>
            </Pressable>
          )}

          {continuous ? (
            <Pressable onPress={handleClose} style={styles.doneBtn}>
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <Pressable style={styles.closeButton} onPress={handleClose}>
        <Ionicons name="close" size={28} color="#fff" />
      </Pressable>
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
  manualBg: { ...StyleSheet.absoluteFillObject, backgroundColor: "#101014" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  scanWindow: {
    width: 260,
    height: 260,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.85)",
    backgroundColor: "transparent",
  },
  feedback: {
    position: "absolute",
    top: 84,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(22,163,74,0.92)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    maxWidth: 340,
  },
  feedbackError: {
    backgroundColor: "rgba(220,38,38,0.92)",
  },
  feedbackText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
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
  linkBtn: { alignItems: "center", paddingVertical: 4 },
  linkText: { color: "rgba(255,255,255,0.85)", fontSize: 13 },
  doneBtn: {
    alignItems: "center",
    backgroundColor: "#3b82f6",
    borderRadius: 10,
    paddingVertical: 12,
  },
  doneBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  closeButton: {
    position: "absolute",
    top: 18,
    right: 18,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
});
