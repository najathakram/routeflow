import * as React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { gateScan, type ScanGateState, type ScanOutcome } from "../lib/scan-loop";

export interface ScanCameraProps {
  /**
   * Called with each accepted code. The resolved value is handed back through
   * {@link ScanCameraProps.onOutcome} — the engine itself only acts on `close`.
   */
  onScanned: (code: string) => ScanOutcome | Promise<ScanOutcome>;
  onOutcome?: (outcome: ScanOutcome) => void;
  /** Feed detections only while true — pause without tearing the camera down. */
  active?: boolean;
  /** Keep decoding after a scan. Single-shot latches after the first code. */
  continuous?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Web-only: rendered in the manual-entry fallback card. Ignored here. */
  footer?: React.ReactNode;
  /** Web-only: idle help text + manual-entry link. Ignored here. */
  hint?: boolean;
  /** Web-only: camera ⇄ manual-entry fallback. Ignored here. */
  onModeChange?: (mode: "camera" | "manual") => void;
}

/**
 * Camera permission for the scanning surfaces (full-screen BarcodeScanner,
 * split-view ScanOrderSheet), which render their own prompt UI over it.
 *
 * `enabled` exists for callers that stay mounted while closed — a Modal-based
 * sheet would otherwise ask for the camera the moment its screen opens.
 */
export function useScanCameraPermission(enabled = true): {
  granted: boolean;
  request: () => void;
} {
  const [permission, requestPermission] = useCameraPermissions();
  React.useEffect(() => {
    if (enabled && !permission?.granted) requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return {
    granted: !!permission?.granted,
    request: () => {
      void requestPermission();
    },
  };
}

/**
 * The barcode camera ENGINE: fills its parent, draws no chrome and assumes no
 * particular size, so it can be a full-screen overlay or the top zone of a
 * split-view sheet. Mount it only once the permission is granted — the caller
 * owns the permission UI.
 */
export function ScanCamera({
  onScanned,
  onOutcome,
  active = true,
  continuous = false,
  style,
}: ScanCameraProps) {
  const firedRef = React.useRef(false);
  const gateRef = React.useRef<ScanGateState | null>(null);
  const busyRef = React.useRef(false);
  // Parents recreate these callbacks every render; route them through refs so
  // the handler identity never restarts the camera.
  const onScannedRef = React.useRef(onScanned);
  onScannedRef.current = onScanned;
  const onOutcomeRef = React.useRef(onOutcome);
  onOutcomeRef.current = onOutcome;

  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    if (!continuous) {
      if (firedRef.current) return;
      firedRef.current = true;
      onScannedRef.current(data);
      return;
    }
    if (busyRef.current) return;
    const gated = gateScan(data, gateRef.current, Date.now());
    gateRef.current = gated.state;
    if (!gated.accept) return;
    busyRef.current = true;
    try {
      onOutcomeRef.current?.(await onScannedRef.current(data));
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

  return (
    <View style={[styles.root, style]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{
          barcodeTypes: ["ean13", "ean8", "code128", "qr", "upc_a", "upc_e", "code39"],
        }}
        onBarcodeScanned={active ? handleBarcodeScanned : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
});
