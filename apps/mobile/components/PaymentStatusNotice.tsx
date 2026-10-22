import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { PAYMENT_STATUS_COPY } from "../lib/payment-status-check";
import type { PaymentStatusCheck } from "../lib/use-payment-status-check";

/**
 * SA-824: shown at the top of every record-payment screen. While the outcome is unknown it explains and
 * offers "Check payment status" (the screen keeps its submit off meanwhile); afterwards it shows the
 * answer's fixed line. Renders nothing otherwise.
 */
export function PaymentStatusNotice({ status }: { status: PaymentStatusCheck }) {
  if (!status.unknown && !status.message) return null;
  return (
    <View style={styles.box} accessibilityRole="alert">
      {status.unknown ? <Text style={styles.text}>{PAYMENT_STATUS_COPY.unknownHint}</Text> : null}
      {status.message ? <Text style={styles.strong}>{status.message}</Text> : null}
      {status.unknown ? (
        <Pressable
          style={[styles.btn, status.checking && { opacity: 0.6 }]}
          disabled={status.checking}
          onPress={() => void status.check()}
          accessibilityRole="button"
        >
          {status.checking ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnText}>{PAYMENT_STATUS_COPY.action}</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: ios.fill, borderRadius: 10, padding: 12, gap: 8, marginBottom: 12 },
  text: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label },
  strong: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.label },
  btn: {
    backgroundColor: ios.brand,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_700Bold" },
});
