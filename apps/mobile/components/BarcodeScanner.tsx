import * as React from "react";
import { StyleSheet, View, Text, TouchableOpacity, Dimensions } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { gateScan, ScanGateState, ScanOutcome, ScanFeedback } from "../lib/scan-loop";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const WINDOW_SIZE = SCREEN_WIDTH * 0.7;

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

export function BarcodeScanner({ onScanned, onClose, continuous = false }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const firedRef = React.useRef(false);
  const gateRef = React.useRef<ScanGateState | null>(null);
  const busyRef = React.useRef(false);
  const [feedback, setFeedback] = React.useState<ScanFeedback | null>(null);
  const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, []);

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

  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (!continuous) {
      if (firedRef.current) return;
      firedRef.current = true;
      onScanned(data);
      return;
    }
    // Continuous: gate out per-frame repeats, then keep scanning after each add.
    if (busyRef.current) return;
    const gated = gateScan(data, gateRef.current, Date.now());
    gateRef.current = gated.state;
    if (!gated.accept) return;
    busyRef.current = true;
    try {
      const outcome = await onScanned(data);
      if (outcome?.close) {
        onClose();
        return;
      }
      if (outcome?.feedback) showFeedback(outcome.feedback);
    } finally {
      // While onScanned was awaited, every camera frame short-circuited at the
      // busyRef guard WITHOUT calling gateScan, so the sliding window's lastAt
      // stayed frozen at scan-start. If the lookup outran the cooldown, the next
      // in-frame decode of the SAME code would be re-accepted → double-add.
      // Re-anchor the cooldown to completion so a held item can't re-add until
      // it leaves the frame for a full window. A different code still differs
      // from `data` and is accepted immediately.
      gateRef.current = { lastCode: data, lastAt: Date.now() };
      busyRef.current = false;
    }
  };

  if (!permission?.granted) {
    return (
      <View style={styles.overlay}>
        <View style={styles.permissionBox}>
          <Text style={styles.permissionTitle}>Camera Access Required</Text>
          <Text style={styles.permissionBody}>Allow camera access to scan barcodes.</Text>
          <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
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
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{
          barcodeTypes: ["ean13", "ean8", "code128", "qr", "upc_a", "upc_e", "code39"],
        }}
        onBarcodeScanned={handleBarCodeScanned}
      />

      {/* Dark surround */}
      <View style={styles.overlay} pointerEvents="box-none">
        {/* Top dark */}
        <View style={[styles.dark, { height: (SCREEN_HEIGHT - WINDOW_SIZE) / 2 - 40 }]}>
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
          <Text style={styles.hint}>
            {continuous
              ? "Scan items one after another — tap Done when finished"
              : "Align barcode within the box"}
          </Text>
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
  feedbackText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
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
