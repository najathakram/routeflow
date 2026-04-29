import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { Ionicons } from "@expo/vector-icons";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../../components/FormSheet";
import { useProduct, useAdjustProductStock } from "../../../../lib/api/products";
import { showToast } from "../../../../lib/toast";

const REASONS = [
  { id: "RECEIVED", label: "Received" },
  { id: "DAMAGED", label: "Damaged" },
  { id: "COUNT", label: "Count correction" },
  { id: "WASTE", label: "Waste" },
  { id: "OTHER", label: "Other" },
];

export default function AdjustStockScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: product } = useProduct(id ?? "");
  const mut = useAdjustProductStock();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState<string>("COUNT");
  const [notes, setNotes] = useState("");

  const submit = () => {
    if (!id) return;
    const n = Number(delta);
    if (!Number.isFinite(n) || n === 0) {
      showToast("Use a positive number to add stock or a negative number to remove.");
      return;
    }
    mut.mutate(
      {
        productId: id,
        quantity: n,
        reference: reason,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          showToast(`Stock ${n > 0 ? "added" : "removed"}`);
          router.back();
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="Adjust stock"
      subtitle={product?.name}
      submitLabel={mut.isPending ? "Saving…" : "Apply"}
      onSubmit={submit}
      submitting={mut.isPending}
    >
      <FormSection title="Quantity">
        {product && (
          <View style={styles.currentRow}>
            <Text style={styles.currentLabel}>Current stock</Text>
            <Text style={styles.currentValue}>
              {Number(product.currentStock ?? 0)} units
            </Text>
          </View>
        )}
        <FormField label="Change (+/−)" hint="Positive to add, negative to remove.">
          <View style={styles.row}>
            <Pressable style={styles.stepBtn} onPress={() => setDelta((d) => shift(d, -1))}>
              <Text style={styles.stepText}>−</Text>
            </Pressable>
            <FormTextInput
              value={delta}
              onChangeText={setDelta}
              placeholder="0"
              keyboardType="numbers-and-punctuation"
              style={{ flex: 1, textAlign: "center" }}
            />
            <Pressable style={styles.stepBtn} onPress={() => setDelta((d) => shift(d, 1))}>
              <Text style={styles.stepText}>+</Text>
            </Pressable>
          </View>
        </FormField>
      </FormSection>

      <FormSection title="Reason">
        <View style={styles.chips}>
          {REASONS.map((r) => {
            const active = reason === r.id;
            return (
              <Pressable
                key={r.id}
                style={[styles.chip, active ? styles.chipActive : styles.chipInactive]}
                onPress={() => setReason(r.id)}
              >
                <Text
                  style={[
                    styles.chipText,
                    active ? styles.chipTextActive : styles.chipTextInactive,
                  ]}
                >
                  {r.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </FormSection>

      <FormSection title="Notes">
        <FormField label="Notes">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            style={{ minHeight: 80 }}
          />
        </FormField>
      </FormSection>

      <View style={styles.helpRow}>
        <Ionicons name="information-circle-outline" size={14} color={ios.label2} />
        <Text style={styles.help}>Adjustments are logged as stock movements.</Text>
      </View>
    </FormSheet>
  );
}

function shift(current: string, by: number): string {
  const n = Number(current);
  if (!Number.isFinite(n)) return String(by);
  return String(n + by);
}

const styles = StyleSheet.create({
  currentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 2,
    marginBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  currentLabel: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  currentValue: { fontSize: 16, fontFamily: "Inter_700Bold", color: ios.label },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: {
    width: 46,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.brandWash,
  },
  stepText: { color: ios.brand, fontSize: 22, fontFamily: "Inter_700Bold" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  chipActive: { backgroundColor: ios.brand },
  chipInactive: { backgroundColor: ios.fill3 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  chipTextActive: { color: "#fff" },
  chipTextInactive: { color: ios.label },
  helpRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  help: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
});
