import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ScanOutcome, ScanFeedback } from "../lib/scan-loop";
import { ScanCamera } from "./ScanCamera";

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
}

/** Full-screen scanning overlay: viewfinder chrome and feedback pill around a
 *  {@link ScanCamera}, which owns the decode loop and manual-entry fallback. */
export function BarcodeScanner({
  onScanned,
  onClose,
  continuous = false,
  paused = false,
  active = true,
}: Props) {
  // Swallow codes while paused rather than unmounting the camera.
  const guardedScan = React.useCallback(
    (code: string) => (paused ? undefined : onScanned(code)),
    [paused, onScanned],
  );
  const [feedback, setFeedback] = React.useState<ScanFeedback | null>(null);
  const [mode, setMode] = React.useState<"camera" | "manual">("camera");
  const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleOutcome = (outcome: ScanOutcome) => {
    if (outcome?.close) {
      onClose();
      return;
    }
    if (outcome?.feedback) showFeedback(outcome.feedback);
  };

  const doneFooter = continuous ? (
    <Pressable onPress={onClose} style={styles.doneBtn}>
      <Text style={styles.doneBtnText}>Done</Text>
    </Pressable>
  ) : null;

  return (
    <View style={StyleSheet.absoluteFill}>
      <ScanCamera
        style={StyleSheet.absoluteFill}
        onScanned={guardedScan}
        onOutcome={handleOutcome}
        continuous={continuous}
        active={active && !paused}
        onModeChange={setMode}
        footer={doneFooter}
      />

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
            {feedback.action ? (
              <Pressable
                onPress={() => feedback.action?.onPress()}
                style={styles.feedbackActionBtn}
                accessibilityRole="button"
                accessibilityLabel={feedback.action.label}
              >
                <Text style={styles.feedbackActionText}>{feedback.action.label}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {mode === "camera" ? <View style={styles.scanWindow} pointerEvents="none" /> : null}
      </View>

      <Pressable style={styles.closeButton} onPress={onClose}>
        <Ionicons name="close" size={28} color="#fff" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
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
