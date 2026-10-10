import * as React from "react";
import { AppState, StyleSheet, View, Text, TouchableOpacity, Dimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ScanOutcome, ScanFeedback } from "../lib/scan-loop";
import { shouldDecode } from "@routeflow/scanning";
import { ScanCamera, useScanCameraPermission } from "./ScanCamera";
import { useScanMode } from "../lib/scan-mode-store";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const WINDOW_SIZE = SCREEN_WIDTH * 0.7;
// The EXACT rect the "Clear scan window" box below renders at. It is ScanCamera's enforced aimBox when `aimAssist` is on, so
// the drawing and the enforcement are ONE source: this window sits 40dp above centre (room for the feedback pill / hint),
// and an enforced box that merely "looked" the same would reject a scan the operator can see is correctly aligned.
const AIM_BOX = {
  x: (SCREEN_WIDTH - WINDOW_SIZE) / 2,
  y: (SCREEN_HEIGHT - WINDOW_SIZE) / 2 - 40,
  width: WINDOW_SIZE,
  height: WINDOW_SIZE,
};

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
  /**
   * Ignore incoming codes while a sheet (picker / create) is stacked over the
   * scanner. The camera stays MOUNTED — tearing it down and re-opening it is
   * what made a hand-off cost the operator an extra trip back to scan mode.
   */
  paused?: boolean;
  /**
   * Pause the underlying camera decode loop without unmounting it — a sheet
   * (e.g. a price edit) stacked over the scanner passes `false` here instead
   * of tearing the camera down. Defaults `true`.
   */
  active?: boolean;
  /**
   * OPT-IN (default false): enforce the drawn scan window as an aim box and require a steady read before a code counts.
   * Only the driver screen passes it; every other caller of this shared scanner is unchanged.
   */
  aimAssist?: boolean;
}

/** Full-screen scanning overlay: permission UI, viewfinder chrome and feedback
 *  pill around a {@link ScanCamera}. */
export function BarcodeScanner({
  onScanned,
  onClose,
  continuous = false,
  paused = false,
  active = true,
  aimAssist = false,
}: Props) {
  // Hold to scan (owner ruling 2026-09-24) rides the aimAssist opt-in: a default caller is always Continuous and never reads
  // the stored mode. In Hold mode the camera stays live but decodes are ignored unless the round button is held.
  const [scanMode, setScanMode] = useScanMode(aimAssist);
  const holdMode = aimAssist && scanMode === "hold";
  const [holding, setHolding] = React.useState(false);
  // The hold ends when the app is backgrounded: the press-out would never arrive.
  React.useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") setHolding(false);
    });
    return () => sub.remove();
  }, []);
  // Swallow codes while paused rather than unmounting the camera.
  const guardedScan = React.useCallback(
    (code: string) => (paused ? undefined : onScanned(code)),
    [paused, onScanned],
  );
  const { granted, request } = useScanCameraPermission();
  const [feedback, setFeedback] = React.useState<ScanFeedback | null>(null);
  const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );

  const showFeedback = (fb: ScanFeedback) => {
    setFeedback(fb);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2500);
  };

  const handleOutcome = (outcome: ScanOutcome) => {
    if (outcome?.close) {
      onClose();
      return;
    }
    if (outcome?.feedback) showFeedback(outcome.feedback);
  };

  if (!granted) {
    return (
      <View style={styles.overlay}>
        <View style={styles.permissionBox}>
          <Text style={styles.permissionTitle}>Camera Access Required</Text>
          <Text style={styles.permissionBody}>Allow camera access to scan barcodes.</Text>
          <TouchableOpacity style={styles.permissionButton} onPress={request}>
            <Text style={styles.permissionButtonText}>Grant Access</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ marginTop: 12 }}>
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 14 }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <ScanCamera
        style={StyleSheet.absoluteFill}
        onScanned={guardedScan}
        onOutcome={handleOutcome}
        continuous={continuous}
        active={active && !paused}
        decode={shouldDecode(holdMode ? "hold" : "continuous", holding)}
        aimAssist={aimAssist}
        aimBox={aimAssist ? AIM_BOX : undefined}
      />

      {/* Dark surround */}
      <View style={styles.overlay} pointerEvents="box-none">
        {/* Top dark */}
        <View style={[styles.dark, { height: (SCREEN_HEIGHT - WINDOW_SIZE) / 2 - 40 }]}>
          {feedback ? (
            <View
              style={[
                styles.feedback,
                feedback.kind === "error" && styles.feedbackError,
                feedback.kind === "info" && styles.feedbackInfo,
              ]}
            >
              <Ionicons
                name={
                  feedback.kind === "added"
                    ? "checkmark-circle"
                    : feedback.kind === "info"
                      ? "information-circle"
                      : "alert-circle"
                }
                size={18}
                color="#fff"
              />
              <Text style={styles.feedbackText} numberOfLines={2}>
                {feedback.text}
              </Text>
              {feedback.action ? (
                <TouchableOpacity
                  onPress={() => feedback.action?.onPress()}
                  style={styles.feedbackActionBtn}
                  accessibilityRole="button"
                  accessibilityLabel={feedback.action.label}
                >
                  <Text style={styles.feedbackActionText}>{feedback.action.label}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* Middle row */}
        <View style={{ flexDirection: "row", height: WINDOW_SIZE }}>
          <View style={[styles.dark, { flex: 1 }]} />
          {/* Clear scan window */}
          <View style={styles.scanWindow} />
          <View style={[styles.dark, { flex: 1 }]} />
        </View>

        {/* Bottom dark */}
        <View style={[styles.dark, { flex: 1 }]}>
          {aimAssist ? (
            <View style={styles.modeRow}>
              {(["continuous", "hold"] as const).map((m) => (
                <TouchableOpacity
                  key={m}
                  accessibilityRole="button"
                  accessibilityLabel={
                    m === "hold" ? "Scan mode: Hold to scan" : "Scan mode: Continuous"
                  }
                  accessibilityState={{ selected: scanMode === m }}
                  onPress={() => {
                    setHolding(false);
                    setScanMode(m);
                  }}
                  style={[styles.modeChip, scanMode === m && styles.modeChipOn]}
                >
                  <Text style={styles.modeChipText}>
                    {m === "hold" ? "Hold to scan" : "Continuous"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          <Text style={styles.hint}>
            {holdMode
              ? "Hold the button while the barcode is in the box"
              : continuous
                ? "Scan items one after another — tap Done when finished"
                : "Align barcode within the box"}
          </Text>
          {holdMode ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Hold to scan"
              accessibilityHint="Press and hold while the barcode is in the box. Hold mode needs a sustained press; use Continuous mode with a screen reader."
              accessibilityState={{ selected: holding }}
              activeOpacity={1}
              onPressIn={() => setHolding(true)}
              onPressOut={() => setHolding(false)}
              style={[styles.holdButton, holding && styles.holdButtonOn]}
            />
          ) : null}
          {continuous ? (
            <TouchableOpacity style={styles.doneButton} onPress={onClose}>
              <Text style={styles.doneButtonText}>Done</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* Close button */}
      <TouchableOpacity style={styles.closeButton} onPress={onClose}>
        <Ionicons name="close" size={28} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "column",
  },
  dark: {
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  scanWindow: {
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.8)",
    borderRadius: 12,
  },
  modeRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  modeChip: {
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.4)",
  },
  modeChipOn: { backgroundColor: "rgba(255,255,255,0.25)", borderColor: "#fff" },
  modeChipText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  holdButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    marginTop: 12,
    borderWidth: 4,
    borderColor: "rgba(255,255,255,0.9)",
    backgroundColor: "rgba(59,130,246,0.7)",
  },
  holdButtonOn: { backgroundColor: "rgba(59,130,246,1)", transform: [{ scale: 0.94 }] },
  hint: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 14,
    marginTop: 16,
  },
  feedback: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(22,163,74,0.92)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    maxWidth: SCREEN_WIDTH - 48,
  },
  feedbackError: {
    backgroundColor: "rgba(220,38,38,0.92)",
  },
  feedbackInfo: {
    backgroundColor: "rgba(51,65,85,0.92)",
  },
  feedbackText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  feedbackActionBtn: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
    marginRight: -6,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  feedbackActionText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  doneButton: {
    marginTop: 16,
    backgroundColor: "#3b82f6",
    paddingHorizontal: 40,
    paddingVertical: 12,
    borderRadius: 999,
  },
  doneButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  closeButton: {
    position: "absolute",
    top: 54,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  permissionBox: {
    backgroundColor: "rgba(0,0,0,0.85)",
    margin: 32,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    marginTop: "auto",
    marginBottom: "auto",
  },
  permissionTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
  },
  permissionBody: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 20,
  },
  permissionButton: {
    backgroundColor: "#3b82f6",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
});
