import * as React from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import type { ScanFlash, TrayRow } from "../lib/scan-tray";
import { QtyStepper } from "./QtyStepper";

const FLASH_HOLD_MS = 120;
const FLASH_FADE_MS = 280;

export interface ScanTrayHandle {
  /** Bring the newest line back into view after a scan. */
  scrollToTop: () => void;
}

export interface ScanTrayProps {
  /** Newest-first, as produced by `trayRowsFrom`. */
  rows: TrayRow[];
  flash: ScanFlash | null;
  /** Receives a TOTAL UNIT count — route boxed lines through `setLineUnits`. */
  onChangeQty: (id: string, qty: number) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
  ListEmptyComponent?: React.ComponentProps<typeof FlatList>["ListEmptyComponent"];
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) setReduce(!!v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => setReduce(!!v));
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return reduce;
}

interface RowProps {
  id: string;
  name: string;
  qty: number;
  qtySummary: string;
  subtotal: number;
  /** The flash nonce when this row is the flashing one, else null. */
  flashNonce: number | null;
  reduceMotion: boolean;
  onChangeQty: (id: string, qty: number) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
}

const TrayRowItem = React.memo(function TrayRowItem({
  id,
  name,
  qty,
  qtySummary,
  subtotal,
  flashNonce,
  reduceMotion,
  onChangeQty,
  onIncrement,
  onDecrement,
  onRemove,
}: RowProps) {
  const anim = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (flashNonce == null) return;
    anim.setValue(1);
    if (reduceMotion) {
      const timer = setTimeout(() => anim.setValue(0), FLASH_HOLD_MS + FLASH_FADE_MS);
      return () => clearTimeout(timer);
    }
    const seq = Animated.sequence([
      Animated.delay(FLASH_HOLD_MS),
      Animated.timing(anim, {
        toValue: 0,
        duration: FLASH_FADE_MS,
        easing: Easing.out(Easing.quad),
        // backgroundColor is not a native-driver-supported prop.
        useNativeDriver: false,
      }),
    ]);
    seq.start();
    return () => seq.stop();
  }, [flashNonce, reduceMotion, anim]);

  const backgroundColor = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ["rgba(11,110,107,0)", ios.brandWashStrong],
  });

  return (
    <Animated.View style={[styles.row, { backgroundColor }]}>
      <View style={styles.rowTop}>
        <Text style={styles.name} numberOfLines={2}>
          {name}
        </Text>
        <Text style={styles.subtotal} numberOfLines={1}>
          ${subtotal.toFixed(2)}
        </Text>
      </View>
      <View style={styles.rowBottom}>
        <Text style={styles.qtySummary} numberOfLines={1}>
          {qtySummary}
        </Text>
        <QtyStepper
          size="mini"
          value={qty}
          onChangeQty={(n) => onChangeQty(id, n)}
          onIncrement={() => onIncrement(id)}
          onDecrement={() => onDecrement(id)}
        />
        <Pressable
          onPress={() => onRemove(id)}
          hitSlop={10}
          style={styles.remove}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${name}`}
        >
          <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
        </Pressable>
      </View>
    </Animated.View>
  );
});

/**
 * The "order so far" list under the scan camera, newest line first.
 *
 * Data arrives PRE-REVERSED rather than using FlatList's `inverted`, which also
 * flips the scroll indicator and the overscroll direction — wrong for a list
 * that reads top-down.
 *
 * All four callbacks must be referentially stable (useCallback in the parent),
 * or every row re-renders on each scan.
 */
export const ScanTray = React.forwardRef<ScanTrayHandle, ScanTrayProps>(function ScanTray(
  { rows, flash, onChangeQty, onIncrement, onDecrement, onRemove, ListEmptyComponent },
  ref,
) {
  const listRef = React.useRef<FlatList<TrayRow>>(null);
  const reduceMotion = useReduceMotion();

  React.useImperativeHandle(
    ref,
    () => ({
      scrollToTop: () => listRef.current?.scrollToOffset({ offset: 0, animated: !reduceMotion }),
    }),
    [reduceMotion],
  );

  const renderItem = React.useCallback(
    ({ item }: { item: TrayRow }) => (
      <TrayRowItem
        id={item.id}
        name={item.name}
        qty={item.qty}
        qtySummary={item.qtySummary}
        subtotal={item.subtotal}
        flashNonce={flash && flash.id === item.id ? flash.nonce : null}
        reduceMotion={reduceMotion}
        onChangeQty={onChangeQty}
        onIncrement={onIncrement}
        onDecrement={onDecrement}
        onRemove={onRemove}
      />
    ),
    [flash, reduceMotion, onChangeQty, onIncrement, onDecrement, onRemove],
  );

  return (
    <FlatList
      ref={listRef}
      data={rows}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      extraData={flash}
      ItemSeparatorComponent={Separator}
      ListEmptyComponent={ListEmptyComponent}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={rows.length === 0 ? styles.emptyContent : undefined}
    />
  );
});

const keyExtractor = (row: TrayRow) => row.id;

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  rowTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  rowBottom: { flexDirection: "row", alignItems: "center", gap: 12 },
  name: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  subtotal: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  qtySummary: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  remove: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: ios.system.redWash,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: ios.separator,
    marginLeft: 16,
  },
  emptyContent: { flexGrow: 1, justifyContent: "center" },
});
