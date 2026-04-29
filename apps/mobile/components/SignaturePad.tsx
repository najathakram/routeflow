import {
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRef, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius } from "@routeflow/ui/tokens";

type Point = { x: number; y: number };
type Stroke = Point[];

interface Props {
  /**
   * Called after each stroke completes or on clear.
   * Receives a PNG data URL on web, a native sentinel string on native,
   * or null when the pad is cleared.
   */
  onCapture: (uri: string | null) => void;
}

function renderStrokesToDataUrl(strokes: Stroke[], w: number, h: number): string {
  const canvas = (document as any).createElement("canvas") as HTMLCanvasElement;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (stroke.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

export function SignaturePad({ onCapture }: Props) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const currentStroke = useRef<Point[]>([]);
  const [renderTick, setRenderTick] = useState(0);
  const padSize = useRef({ width: 300, height: 140 });

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        currentStroke.current = [{ x: locationX, y: locationY }];
        setRenderTick((n) => n + 1);
      },
      onPanResponderMove: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        currentStroke.current.push({ x: locationX, y: locationY });
        setRenderTick((n) => n + 1);
      },
      onPanResponderRelease: () => {
        const stroke = [...currentStroke.current];
        if (stroke.length > 0) {
          setStrokes((prev) => {
            const next = [...prev, stroke];
            if (Platform.OS === "web") {
              try {
                const { width, height } = padSize.current;
                const dataUrl = renderStrokesToDataUrl(next, width, height);
                onCapture(dataUrl);
              } catch {
                onCapture("native-captured");
              }
            } else {
              onCapture("native-captured");
            }
            return next;
          });
        }
        currentStroke.current = [];
        setRenderTick((n) => n + 1);
      },
      onPanResponderTerminate: () => {
        currentStroke.current = [];
      },
    }),
  ).current;

  const handleClear = () => {
    setStrokes([]);
    currentStroke.current = [];
    setRenderTick((n) => n + 1);
    onCapture(null);
  };

  const allStrokes: Stroke[] = [
    ...strokes,
    ...(currentStroke.current.length > 1 ? [currentStroke.current] : []),
  ];
  const hasSignature = strokes.length > 0;

  return (
    <View style={styles.wrapper}>
      <View
        style={styles.pad}
        {...panResponder.panHandlers}
        onLayout={(e) => {
          padSize.current = {
            width: e.nativeEvent.layout.width,
            height: e.nativeEvent.layout.height,
          };
        }}
      >
        {allStrokes.map((stroke, sIdx) =>
          stroke.slice(1).map((pt, pIdx) => {
            const prev = stroke[pIdx];
            const dx = pt.x - prev.x;
            const dy = pt.y - prev.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 0.5) return null;
            const angle = Math.atan2(dy, dx);
            const cx = (prev.x + pt.x) / 2;
            const cy = (prev.y + pt.y) / 2;
            return (
              <View
                key={`${sIdx}-${pIdx}-${renderTick}`}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: cx - len / 2,
                  top: cy - 1.5,
                  width: len,
                  height: 3,
                  backgroundColor: colors.navy.DEFAULT,
                  borderRadius: 1.5,
                  transform: [{ rotate: `${angle}rad` }],
                }}
              />
            );
          }),
        )}
        {!hasSignature && currentStroke.current.length === 0 && (
          <Text style={styles.placeholder}>Sign here</Text>
        )}
      </View>

      <View style={styles.footer}>
        {hasSignature ? (
          <>
            <View style={styles.capturedBadge}>
              <Ionicons name="checkmark-circle" size={16} color={colors.success.DEFAULT} />
              <Text style={styles.capturedText}>Signature captured</Text>
            </View>
            <Pressable style={styles.clearBtn} onPress={handleClear}>
              <Ionicons name="trash-outline" size={15} color={colors.danger.DEFAULT} />
              <Text style={styles.clearBtnText}>Clear</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.hint}>Use your finger to sign above</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 8 },
  pad: {
    height: 140,
    backgroundColor: "#f8fafc",
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    overflow: "hidden",
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  placeholder: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#cbd5e1",
    pointerEvents: "none",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 24,
  },
  capturedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  capturedText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.success.DEFAULT,
  },
  clearBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.danger.DEFAULT,
  },
  clearBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.danger.DEFAULT,
  },
  hint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
