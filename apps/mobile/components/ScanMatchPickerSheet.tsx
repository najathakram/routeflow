import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import type { ScanMatchPickerProps } from "../lib/use-scan-match-picker";

type Row = { id: string; name?: string | null; sku?: string | null; unit?: string | null };

/**
 * B1220: a scanned code matched several products and none exactly. Lists EVERY match; each row
 * carries its own Add/Apply button, and nothing is committed until one is pressed.
 */
export function ScanMatchPickerSheet<T extends Row>({
  visible,
  matches,
  confirmText,
  onChoose,
  onClose,
}: ScanMatchPickerProps<T>) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>Several products match</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled">
          {matches.map((m) => (
            <View key={m.id} style={styles.row}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={2}>
                  {m.name || "Unnamed product"}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {m.sku ? `SKU ${m.sku}` : "No SKU"}
                  {m.unit ? ` · ${m.unit}` : ""}
                </Text>
              </View>
              <Pressable
                style={styles.action}
                onPress={() => onChoose(m)}
                accessibilityRole="button"
                accessibilityLabel={`${confirmText} ${m.name ?? "product"}`}
              >
                <Text style={styles.actionText}>{confirmText}</Text>
              </Pressable>
            </View>
          ))}
          <View style={{ height: 24 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    maxHeight: "70%",
    backgroundColor: ios.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  title: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  cancel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.brand },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  meta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  action: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
  },
  actionText: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.brand },
});
