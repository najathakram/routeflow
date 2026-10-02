import { Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";

/** #2865 case c (SA-632): a line waiting on its default unit (one shape for every row that shows it). */
export interface PendingUnit {
  status: "loading" | "failed";
  /** Taps recorded so far (N taps = N of the default unit once it resolves). */
  taps: number;
  onRetry: () => void;
}

/** "3 · loading units", or the readable failure with a real Retry button. The qty controls stay locked either way. */
export function PendingUnitNotice({ pendingUnit }: { pendingUnit: PendingUnit }) {
  if (pendingUnit.status === "failed") {
    return (
      <View style={styles.row} accessibilityRole="alert">
        <Text style={styles.err}>
          {`${pendingUnit.taps} added · Couldn't load the selling units. `}
        </Text>
        <Pressable
          onPress={pendingUnit.onRetry}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Retry loading the selling units"
        >
          <Text style={styles.retry}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.row} accessibilityRole="progressbar" accessibilityState={{ busy: true }}>
      <Text style={styles.msg}>{`${pendingUnit.taps} · loading units`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  msg: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  err: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label },
  retry: { fontSize: 12, fontFamily: "Inter_700Bold", color: ios.brand },
});
