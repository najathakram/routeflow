import * as React from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { ScanOutcome } from "../lib/scan-loop";
import { normalizeScanCode } from "../lib/barcode-normalize";
import {
  continuousFrameScanned,
  createContinuousScanState,
  scanSettled,
  type AimBoxRect,
  type BarcodeBoundsLike,
  type ContinuousScanState,
} from "@routeflow/scanning";

export interface ScanCameraProps {
  /**
   * Called with each accepted code. The resolved value is handed back through
   * {@link ScanCameraProps.onOutcome} — the engine itself only acts on `close`.
   */
  onScanned: (code: string) => ScanOutcome | Promise<ScanOutcome>;
  onOutcome?: (outcome: ScanOutcome) => void;
  /**
   * Fires whenever the pending buffer's resolving state flips — lets a host
   * sheet (ScanOrderSheet) show a "looking up…" indicator instead of dead
   * frames while a scan resolves (F30 / R2, REG-B192).
   */
  onResolvingChange?: (isResolving: boolean) => void;
  /** Feed detections only while true — pause without tearing the camera down. */
  active?: boolean;
  /** Keep decoding after a scan. Single-shot latches after the first code. */
  continuous?: boolean;
  /**
   * Owner ruling 2026-09-24 (`project_scan_aimbox_hold_to_scan_2026-09-24`): in continuous
   * mode, only a barcode decoded inside this rect counts as a candidate scan, same
   * coordinate space as expo-camera's own `BarcodeScanningResult.bounds` (view-relative
   * pixels, NOT normalized).
   *
   * OMITTED MEANS NO ENFORCEMENT — not a hidden default box. #2131 review (round 1, point
   * 3): an earlier version fell back to a box centered on this component's OWN measured
   * layout, which silently rejected scans for any host whose actual drawn box sat
   * elsewhere (`BarcodeScanner.tsx`'s viewfinder is offset 40dp above center) or drew NO
   * box at all (`ScanOrderSheet`, pending #2059's shared-viewfinder work) — an invisible
   * enforced rect the operator has no way to align against. A host that draws a box MUST
   * pass the exact rect it draws; a host that draws none must pass nothing.
   */
  aimBox?: AimBoxRect | null;
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
  onResolvingChange,
  active = true,
  continuous = false,
  aimBox,
  style,
}: ScanCameraProps) {
  const firedRef = React.useRef(false);
  // Replaces the old drop-not-queue `busyRef` boolean (F30 / R2, REG-B192): a bounded,
  // deduped queue behind the one code currently resolving, so a detection that arrives
  // mid-resolve is buffered instead of silently lost. Bundles the gate, buffer AND
  // steady-read streaks into one pure, tested composition (`continuousFrameScanned`,
  // #2131 review round 1) — aim box and steady-read run ahead of the gate and reject
  // silently on their own, but (unlike the pre-#2131 version) a not-yet-steady in-box
  // frame still touches the gate's `lastSeenAt` clock, so a held code's absence-gap clock
  // never goes stale while its streak is still filling.
  const engineRef = React.useRef<ContinuousScanState>(createContinuousScanState());
  const [torchOn, setTorchOn] = React.useState(false);
  // Parents recreate these callbacks every render; route them through refs so
  // the handler identity never restarts the camera.
  const onScannedRef = React.useRef(onScanned);
  onScannedRef.current = onScanned;
  const onOutcomeRef = React.useRef(onOutcome);
  onOutcomeRef.current = onOutcome;
  const onResolvingChangeRef = React.useRef(onResolvingChange);
  onResolvingChangeRef.current = onResolvingChange;

  /**
   * Resolves one accepted code, then drains whatever the buffer queued while
   * it was in flight — recursing (not looping) so each queued code gets its
   * own resolve/outcome cycle exactly like a fresh scan would.
   *
   * The buffer advances only once `onScanned` has actually SETTLED. The
   * per-scan deadline that keeps a slow lookup from holding it open lives in
   * the handler itself (`lib/scan-ladder`'s SCAN_RESOLVE_TIMEOUT_MS), where it
   * can abort the request: racing a timer here would report a failure while
   * the abandoned lookup still added the item AND would start the next
   * buffered code alongside one still in flight.
   */
  const resolveCode = React.useCallback(async (code: string) => {
    try {
      onOutcomeRef.current?.(await onScannedRef.current(code));
    } finally {
      const result = scanSettled(engineRef.current);
      engineRef.current = result.next;
      if (!result.next.buffer.isResolving) onResolvingChangeRef.current?.(false);
      if (result.startResolving) void resolveCode(result.startResolving);
    }
  }, []);

  const handleBarcodeScanned = ({ data, bounds }: { data: string; bounds?: BarcodeBoundsLike }) => {
    if (!continuous) {
      if (firedRef.current) return;
      firedRef.current = true;
      onScannedRef.current(data);
      return;
    }

    const now = Date.now();
    // Aim box, steady-read and the dedupe gate all compose inside this ONE pure call
    // (#2131 review round 1) — see continuousFrameScanned's own doc for the ordering and
    // why a not-yet-steady in-box frame still touches the gate's lastSeenAt clock.
    const step = continuousFrameScanned(engineRef.current, data, now, {
      bounds,
      aimBox,
      candidatesOf: normalizeScanCode,
    });
    engineRef.current = step.next;
    if (step.indicator === "on") onResolvingChangeRef.current?.(true);
    if (step.indicator === "off") onResolvingChangeRef.current?.(false);
    if (step.startResolving) void resolveCode(step.startResolving);
  };

  return (
    <View style={[styles.root, style]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        // itf14 is the standard outer-case barcode for a distributor and was
        // missing from every format list.
        barcodeScannerSettings={{
          barcodeTypes: ["ean13", "ean8", "code128", "qr", "upc_a", "upc_e", "code39", "itf14"],
        }}
        autofocus="on"
        // Works on BOTH iOS and Android here — the one thing native gets that
        // web-on-iPhone cannot (Safari exposes no torch API).
        enableTorch={torchOn}
        onBarcodeScanned={active ? handleBarcodeScanned : undefined}
      />
      <Pressable
        onPress={() => setTorchOn((on) => !on)}
        style={[styles.torchBtn, torchOn && styles.torchBtnOn]}
        accessibilityRole="button"
        accessibilityLabel={torchOn ? "Turn off the light" : "Turn on the light"}
        accessibilityState={{ selected: torchOn }}
      >
        <Text style={styles.torchText}>{torchOn ? "Light on" : "Light"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  torchBtn: {
    position: "absolute",
    left: 16,
    // Clear of the bottom card and of the pills the host sheet puts on top.
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
