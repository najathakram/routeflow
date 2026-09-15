import * as React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import type { ScanOutcome } from "../lib/scan-loop";
import type { ScanFlash, TrayRow } from "../lib/scan-tray";
import { scanHaptic } from "../lib/haptics";
import {
  INITIAL_SCAN_SLOT,
  reduceScanSlot,
  scanSlotEffects,
  type ScanFeedbackSlotState,
} from "../lib/scan-feedback-slot";
import { ScanCamera, useScanCameraPermission } from "./ScanCamera";
import { ScanTray, type ScanTrayHandle } from "./ScanTray";

export interface ScanOrderSheetProps {
  visible: boolean;
  /**
   * Freeze decoding without unmounting the camera — used while a sheet raised
   * from a pill action (e.g. "create this product") is on top. The web stream
   * stays open, so resuming is instant and never re-prompts getUserMedia.
   */
  paused?: boolean;
  /** Newest-first tray rows; the parent bumps the scan order on every accepted scan. */
  rows: TrayRow[];
  flash: ScanFlash | null;
  totalItems: number;
  total: number;
  /**
   * Handles one accepted code. A `{close:true}` outcome closes the sheet (the
   * caller is handing off, e.g. to "create this product?"); an `error` feedback
   * surfaces as the capture-zone pill. Success needs no outcome — the tray row
   * landing in the same frame IS the confirmation.
   */
  onScanned: (code: string) => ScanOutcome | Promise<ScanOutcome>;
  /** Receives a TOTAL UNIT count — route boxed lines through `setLineUnits`. */
  onChangeQty: (id: string, qty: number) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
  /**
   * Edit a tray line's price without leaving the camera. Optional: a surface
   * that has no price editor (or no permission to reprice) omits it and the
   * tray renders no price affordance at all, exactly as before.
   *
   * The host owns the editor AND the rules — a SPECIAL-tier line is the
   * customer's permanent price and must stay locked (NewOrderScreen's
   * `isSpecialFor`), so this only ever reports the tapped row id.
   */
  onEditPrice?: (id: string) => void;
  /** Leave scanning for the full builder (prices, notes, customer, submit). */
  onReview: () => void;
  onDone: () => void;
}

/**
 * Split-view scan mode: camera on top, the order so far underneath.
 *
 * The scanner used to be a full-screen overlay, so an item added mid-scan was
 * invisible until the operator closed the camera. Here the newest line lands at
 * the top of the tray in the same frame the scan is accepted.
 *
 * Owns no order state — every mutation goes back out through the callbacks.
 */
export function ScanOrderSheet({
  visible,
  paused = false,
  rows,
  flash,
  totalItems,
  total,
  onScanned,
  onChangeQty,
  onIncrement,
  onDecrement,
  onRemove,
  onEditPrice,
  onReview,
  onDone,
}: ScanOrderSheetProps) {
  const insets = useSafeAreaInsets();
  const { granted, request } = useScanCameraPermission(visible);
  const trayRef = React.useRef<ScanTrayHandle>(null);
  // The pill is a state MACHINE (lib/scan-feedback-slot.ts), not a setter pair:
  // a settled outcome owns the slot whichever way it went, so a successful
  // scan now clears the previous scan's miss pill instead of letting
  // `No product for "X"` sit over the camera — Create button live — while the
  // item is already in the tray.
  const [slot, setSlot] = React.useState<ScanFeedbackSlotState>(INITIAL_SCAN_SLOT);
  const error = slot.pill;
  // F30 / R2, REG-B192: ScanCamera now buffers instead of silently dropping a
  // scan that arrives while a lookup is in flight — this surfaces that state
  // so the operator sees "looking up…" instead of dead frames.
  const [isResolving, setIsResolving] = React.useState(false);

  // One timer per pill, keyed on the slot nonce: a replacement pill cancels
  // its predecessor's expiry on cleanup, and unmount clears it too.
  const { nonce, ttlMs } = slot;
  React.useEffect(() => {
    if (ttlMs == null) return;
    const timer = setTimeout(
      () => setSlot((prev) => reduceScanSlot(prev, { type: "expire", nonce })),
      ttlMs,
    );
    return () => clearTimeout(timer);
  }, [nonce, ttlMs]);

  // The camera unmounts when the sheet closes (below) without necessarily
  // reaching its own resolve-complete callback — don't strand the indicator on.
  // Nor the pill: a miss from the previous scan session must not greet the
  // operator over a fresh camera.
  React.useEffect(() => {
    if (visible) return;
    setIsResolving(false);
    setSlot((prev) => reduceScanSlot(prev, { type: "reset" }));
  }, [visible]);

  const dismissError = () => setSlot((prev) => reduceScanSlot(prev, { type: "dismiss" }));

  const handleOutcome = (outcome: ScanOutcome) => {
    // Functional update: a burst of scans can settle between renders, and each
    // must fold onto the slot the one before it left.
    setSlot((prev) => reduceScanSlot(prev, { type: "outcome", outcome }));
    for (const effect of scanSlotEffects(outcome)) {
      if (effect === "error-cue") scanHaptic("error");
      if (effect === "close-sheet") onDone();
      if (effect === "added-cue") {
        scanHaptic("added");
        // Web has no haptics (haptics.ts no-ops there) and the app plays no
        // sound, so without this a mobile-web scan lands with zero confirmation.
        if (typeof navigator !== "undefined") navigator.vibrate?.(30);
      }
      if (effect === "scroll-tray-top") trayRef.current?.scrollToTop();
    }
  };

  const itemsLabel = `${totalItems} item${totalItems === 1 ? "" : "s"}`;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onDone}>
      <View style={styles.root}>
        <View style={styles.capture}>
          {visible && granted ? (
            <ScanCamera
              style={StyleSheet.absoluteFill}
              onScanned={onScanned}
              onOutcome={handleOutcome}
              onResolvingChange={setIsResolving}
              active={!paused}
              continuous
              hint={false}
            />
          ) : (
            <View style={styles.permission}>
              <Text style={styles.permissionTitle}>Camera access required</Text>
              <Text style={styles.permissionBody}>Allow camera access to scan items.</Text>
              <Pressable style={styles.permissionBtn} onPress={request}>
                <Text style={styles.permissionBtnText}>Grant access</Text>
              </Pressable>
            </View>
          )}

          <Pressable
            style={[styles.donePill, { top: insets.top + 8 }]}
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel="Done scanning"
          >
            <Text style={styles.donePillText}>Done</Text>
          </Pressable>

          {error ? (
            <View
              style={[styles.errorPill, { top: insets.top + 8 }]}
              accessibilityLiveRegion="polite"
              // Only intercept touches when there's something to tap.
              pointerEvents={error.action ? "auto" : "none"}
            >
              <Ionicons name="alert-circle" size={18} color="#fff" />
              <Text style={styles.errorText} numberOfLines={2}>
                {error.text}
              </Text>
              {error.action ? (
                <Pressable
                  onPress={() => {
                    const run = error.action?.onPress;
                    dismissError();
                    run?.();
                  }}
                  style={styles.errorActionBtn}
                  accessibilityRole="button"
                  accessibilityLabel={error.action.label}
                >
                  <Text style={styles.errorActionText}>{error.action.label}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={styles.tray}>
          <View style={styles.trayHeader}>
            <View style={styles.trayHeaderLeft}>
              <Text style={styles.traySummary}>
                {itemsLabel} · ${total.toFixed(2)}
              </Text>
              {isResolving ? (
                <Text style={styles.resolvingText} accessibilityLiveRegion="polite">
                  Looking up…
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={onReview}
              hitSlop={10}
              style={styles.reviewBtn}
              accessibilityRole="button"
            >
              <Text style={styles.reviewText}>Review</Text>
              <Ionicons name="chevron-forward" size={14} color={ios.brand} />
            </Pressable>
          </View>

          <ScanTray
            ref={trayRef}
            rows={rows}
            flash={flash}
            onChangeQty={onChangeQty}
            onIncrement={onIncrement}
            onDecrement={onDecrement}
            onRemove={onRemove}
            onEditPrice={onEditPrice}
            ListEmptyComponent={
              <Text style={styles.empty}>Scan an item — it lands here instantly.</Text>
            }
          />

          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <Pressable
              style={styles.primary}
              onPress={onDone}
              accessibilityRole="button"
              accessibilityLabel={`Done, ${itemsLabel}`}
            >
              <Text style={styles.primaryText}>Done — {itemsLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: ios.bgElev },
  capture: { flex: 0.45, backgroundColor: "#000", overflow: "hidden" },
  permission: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  permissionTitle: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  permissionBody: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    textAlign: "center",
    marginBottom: 8,
  },
  permissionBtn: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 24,
    borderRadius: 12,
    backgroundColor: ios.brand,
  },
  permissionBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  donePill: {
    position: "absolute",
    right: 16,
    minHeight: 44,
    minWidth: 88,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  donePillText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  errorPill: {
    position: "absolute",
    left: 16,
    right: 116,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: "rgba(220,38,38,0.92)",
  },
  errorText: { flexShrink: 1, color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  errorActionBtn: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
    marginRight: -6,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  errorActionText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  tray: { flex: 0.55, backgroundColor: ios.bgElev },
  trayHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    backgroundColor: ios.bg,
  },
  trayHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  traySummary: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  resolvingText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  reviewBtn: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 44 },
  reviewText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.brand },
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    backgroundColor: ios.bgElev,
  },
  primary: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: ios.brand,
  },
  primaryText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
