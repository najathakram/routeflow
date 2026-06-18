import { useEffect, useRef, useState } from "react";
import { Animated, Dimensions, PanResponder, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { BarcodeScanner } from "./BarcodeScanner";
import { useFabPositionStore } from "../lib/fab-position-store";

interface Props {
  /** Called with the scanned code string. */
  onScanned: (code: string) => void;
  /** Hide the FAB when something else has focus (e.g. a modal is open). */
  hidden?: boolean;
}

const FAB_SIZE = 56;
const EDGE_MARGIN = 16;
const TWO_THIRDS = 2 / 3;
const DRAG_THRESHOLD = 5;
/** Reserve space for the iOS bottom tab bar so the FAB doesn't sit on top of it. */
const BOTTOM_RESERVED = 100;
/** Reserve space for the top safe area so the FAB doesn't sit under the notch. */
const TOP_RESERVED = 60;

/**
 * Floating barcode-scan button. Drag it anywhere on screen — releases snap
 * to the nearest left/right edge and the position is remembered (in
 * `useFabPositionStore`) so the next screen mount picks up where the
 * operator left it.
 *
 * The default position is the right edge at ~2/3 down the screen — within
 * easy thumb reach for either-handed phone use.
 *
 * Tapping (no drag) opens the camera scanner overlay; the result is forwarded
 * to `onScanned`. Drag distance > DRAG_THRESHOLD suppresses the tap so the
 * operator never accidentally fires the scanner mid-drag.
 *
 * Why this is shared rather than per-screen: the user complained that on
 * /new-order (and the other scan sites) they had to scroll up to find the
 * scanner button. A floating button keeps the action one tap away regardless
 * of scroll position.
 */
export function BarcodeFab({ onScanned, hidden = false }: Props) {
  const { width, height } = Dimensions.get("window");
  const persisted = useFabPositionStore();

  const initialX = persisted.x ?? width - FAB_SIZE - EDGE_MARGIN;
  const initialY = persisted.y ?? height * TWO_THIRDS - FAB_SIZE / 2;

  const pan = useRef(new Animated.ValueXY({ x: initialX, y: initialY })).current;
  const wasDragged = useRef(false);
  const [scanOpen, setScanOpen] = useState(false);

  // Re-sync the animated position whenever the persisted store changes (e.g.
  // user dragged on a different screen). Skip during active dragging so the
  // gesture isn't yanked.
  useEffect(() => {
    if (persisted.x != null && persisted.y != null) {
      pan.setValue({ x: persisted.x, y: persisted.y });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted.x, persisted.y]);

  // Clamp position into the visible area whenever the window dimensions change
  // (orientation change, web window resize). Without this the FAB can end up
  // off-screen after rotating or resizing.
  useEffect(() => {
    const sub = Dimensions.addEventListener("change", ({ window }) => {
      const cx = (pan.x as any)._value;
      const cy = (pan.y as any)._value;
      const maxX = window.width - FAB_SIZE - EDGE_MARGIN;
      const maxY = window.height - FAB_SIZE - BOTTOM_RESERVED;
      const nextX = Math.min(Math.max(EDGE_MARGIN, cx), maxX);
      const nextY = Math.min(Math.max(TOP_RESERVED, cy), maxY);
      pan.setValue({ x: nextX, y: nextY });
      persisted.setPosition(nextX, nextY);
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const responder = useRef(
    PanResponder.create({
      // Don't grab the touch on press start — let it pass through to the
      // Pressable so simple taps still register.
      onStartShouldSetPanResponder: () => false,
      // Take over once the finger moves past the drag threshold.
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > DRAG_THRESHOLD || Math.abs(g.dy) > DRAG_THRESHOLD,
      onPanResponderGrant: () => {
        wasDragged.current = false;
        pan.extractOffset();
      },
      onPanResponderMove: (_, g) => {
        // Mark as dragged so the press handler skips firing the scanner.
        if (Math.abs(g.dx) > DRAG_THRESHOLD || Math.abs(g.dy) > DRAG_THRESHOLD) {
          wasDragged.current = true;
        }
        Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false })(_, g);
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        const { width: w, height: h } = Dimensions.get("window");
        const currentX = (pan.x as any)._value;
        const currentY = (pan.y as any)._value;
        // Snap to the nearer vertical edge so the FAB always rests on a side.
        const snapToLeft = currentX + FAB_SIZE / 2 < w / 2;
        const targetX = snapToLeft ? EDGE_MARGIN : w - FAB_SIZE - EDGE_MARGIN;
        const targetY = Math.min(Math.max(TOP_RESERVED, currentY), h - FAB_SIZE - BOTTOM_RESERVED);
        Animated.spring(pan, {
          toValue: { x: targetX, y: targetY },
          useNativeDriver: false,
          friction: 7,
        }).start(() => {
          persisted.setPosition(targetX, targetY);
        });
      },
    }),
  ).current;

  const handlePress = () => {
    if (wasDragged.current) {
      wasDragged.current = false;
      return;
    }
    setScanOpen(true);
  };

  if (hidden) return null;

  return (
    <>
      <Animated.View
        style={[styles.fab, { transform: pan.getTranslateTransform() }]}
        {...responder.panHandlers}
        // pointer events on web: the View needs to receive pointer events even
        // though it's absolutely positioned, but children should also get them.
        pointerEvents="box-none"
      >
        <Pressable
          style={({ pressed }) => [styles.fabBtn, pressed && styles.fabBtnPressed]}
          onPress={handlePress}
          accessibilityLabel="Scan barcode"
          accessibilityRole="button"
        >
          <Ionicons name="barcode-outline" size={26} color="#fff" />
        </Pressable>
      </Animated.View>

      {scanOpen ? (
        <View style={styles.scannerOverlay}>
          <BarcodeScanner
            onScanned={(code) => {
              setScanOpen(false);
              onScanned(code);
            }}
            onClose={() => setScanOpen(false)}
          />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    top: 0,
    left: 0,
    width: FAB_SIZE,
    height: FAB_SIZE,
    zIndex: 1000,
  },
  fabBtn: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  fabBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.97 }],
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2000,
  },
});
