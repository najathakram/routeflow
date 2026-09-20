import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import type { BlockedLine } from "@routeflow/types";
import { restrictionReasonText } from "../lib/selling-restricted";

interface Props {
  /** The blocked lines from a 409 SELLING_RESTRICTED; null = closed. */
  lines: BlockedLine[] | null;
  onClose: () => void;
}

/**
 * Lists what a save was refused for (409 SELLING_RESTRICTED): product, category and a plain reason.
 * There is no "sell anyway" exit — the server has no override for a selling restriction — so the
 * only action is to close and take the lines out. Mirrors web's BlockedLinesDialog.
 */
export function BlockedLinesModal({ lines, onClose }: Props) {
  if (!lines) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Ionicons name="alert-circle-outline" size={20} color={ios.system.red} />
            <Text style={styles.title}>Can't sell these items</Text>
          </View>
          <Text style={styles.message}>
            Remove the items below from this order, then save again.
          </Text>
          <ScrollView style={styles.list}>
            {lines.map((l) => (
              <View key={`${l.productId}:${l.ruleId ?? l.reason}`} style={styles.row}>
                <Text style={styles.name}>{l.productName}</Text>
                {l.categoryName ? <Text style={styles.meta}>{l.categoryName}</Text> : null}
                <Text style={styles.reason}>{restrictionReasonText(l)}</Text>
              </View>
            ))}
          </ScrollView>
          <Pressable style={styles.btn} onPress={onClose} accessibilityRole="button">
            <Text style={styles.btnText}>OK</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 20 },
  card: { backgroundColor: ios.bgElev, borderRadius: 18, padding: 18, gap: 12, maxHeight: "80%" },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  message: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 20 },
  list: { flexGrow: 0 },
  row: { backgroundColor: ios.fill3, borderRadius: 12, padding: 12, marginBottom: 8, gap: 2 },
  name: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label },
  meta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  reason: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.system.red },
  btn: { paddingVertical: 12, borderRadius: 12, alignItems: "center", backgroundColor: ios.brand },
  btnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
