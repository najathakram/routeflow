import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { useCostHistory } from "../lib/api/cost-history";

function costTypeLabel(type: string): string {
  if (type === "PURCHASE") return "Bill";
  if (type === "COST_BASIS") return "Manual";
  return type.replace(/_/g, " ").toLowerCase();
}

/**
 * Cost history bottom sheet (pos-cost-roles-spec §1) — the bills/lots behind
 * the live cost number, opened by tapping the cost text in the sale builder /
 * order-edit margin hint. Structurally mirrors OptionPickerSheet's chrome
 * (backdrop + handle + scrollable rows) rather than web's portaled hover
 * popover — there's no hover on mobile.
 */
export function CostHistorySheet({
  visible,
  productId,
  onClose,
}: {
  visible: boolean;
  productId: string | null;
  onClose: () => void;
}) {
  const { data: history = [], isLoading } = useCostHistory(visible ? productId : null);
  const recent = [...history].slice(-6).reverse(); // newest first, cap 6 — mirrors web

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Cost history</Text>
        {isLoading ? (
          <ActivityIndicator color={ios.brand} style={{ marginVertical: 20 }} />
        ) : recent.length === 0 ? (
          <Text style={styles.empty}>No purchase cost history yet.</Text>
        ) : (
          <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
            {recent.map((h, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.rowDate}>
                  {new Date(h.date).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </Text>
                <Text style={styles.rowType}>{costTypeLabel(h.type)}</Text>
                <Text style={styles.rowCost}>${h.unitCost.toFixed(4)}</Text>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: ios.gray[3],
    marginBottom: 12,
  },
  title: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label, marginBottom: 10 },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  rowDate: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2, width: 60 },
  rowType: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    backgroundColor: ios.fill3,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    textTransform: "uppercase",
  },
  rowCost: {
    marginLeft: "auto",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
