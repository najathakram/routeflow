import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import type { CreditLimitExceededInfo } from "../lib/credit-limit-error";

interface Props {
  open: boolean;
  info: CreditLimitExceededInfo | null;
  /**
   * Operator-only: navigates to the customer's open invoices to collect a
   * payment. Omit on driver-facing screens — DRIVER has no invoices-list
   * access (apps/api/src/invoices/invoices.controller.ts is class-level
   * @Roles(OPERATOR)), so there is nowhere useful to send a driver. When
   * omitted, only "Cancel" renders.
   */
  onCollectPayment?: () => void;
  onCancel: () => void;
}

/**
 * Blocks a save that would exceed the customer's credit limit (409
 * CREDIT_LIMIT_EXCEEDED). Unlike LicenseGuardModal, there is NO "proceed
 * anyway" exit — the server has no override for this guard (see
 * lib/credit-limit-error.ts). The two legal exits are: go collect a payment
 * first (reduces exposure — the caller re-attempts Save manually after
 * returning, this modal does not auto-retry), or cancel this change. Numbers
 * shown are the server's own limit/exposure — never recomputed here.
 */
export function CreditLimitGuardModal({ open, info, onCollectPayment, onCancel }: Props) {
  if (!info) return null;
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Ionicons name="alert-circle-outline" size={20} color={ios.system.red} />
            <Text style={styles.title}>Credit limit exceeded</Text>
          </View>
          <Text style={styles.message}>{info.message}</Text>

          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>LIMIT</Text>
              <Text style={styles.statValue}>${info.limit.toFixed(2)}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>WOULD BE</Text>
              <Text style={[styles.statValue, styles.statValueOver]}>
                ${info.exposure.toFixed(2)}
              </Text>
            </View>
          </View>

          <View style={styles.btns}>
            <Pressable style={styles.btnGhost} onPress={onCancel}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
            {onCollectPayment ? (
              <Pressable style={styles.btnFill} onPress={onCollectPayment}>
                <Text style={styles.btnFillText}>Collect payment</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 20 },
  card: { backgroundColor: ios.bgElev, borderRadius: 18, padding: 18, gap: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  message: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 20 },
  statRow: { flexDirection: "row", gap: 10 },
  stat: { flex: 1, backgroundColor: ios.fill3, borderRadius: 12, padding: 12 },
  statLabel: { fontSize: 10, fontFamily: "Inter_700Bold", color: ios.label2, letterSpacing: 0.6 },
  statValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  statValueOver: { color: ios.system.red },
  btns: { flexDirection: "row", gap: 10, marginTop: 2 },
  btnGhost: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: ios.fill3,
    alignItems: "center",
  },
  btnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  btnFill: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: ios.brand,
    alignItems: "center",
  },
  btnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
