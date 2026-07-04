import { useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { Ionicons } from "@expo/vector-icons";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../../components/FormSheet";
import { useProduct } from "../../../../lib/api/products";
import { useSetCostBasis } from "../../../../lib/api/inventory";
import { showToast } from "../../../../lib/toast";

export default function SetCostScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: product } = useProduct(id ?? "");
  const mut = useSetCostBasis();
  const [unitCost, setUnitCost] = useState("");
  const [notes, setNotes] = useState("");
  const [applyToLots, setApplyToLots] = useState(false);

  const currentCost = product?.averageCost != null ? Number(product.averageCost) : null;

  const submit = () => {
    if (!id) return;
    const n = Number(unitCost);
    if (!Number.isFinite(n) || n < 0) {
      showToast("Enter the cost of one unit (0 or more).");
      return;
    }
    mut.mutate(
      {
        productId: id,
        unitCost: n,
        notes: notes.trim() || undefined,
        applyToLots: applyToLots || undefined,
      },
      {
        onSuccess: () => {
          showToast("Cost basis set");
          router.back();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="Set cost basis"
      subtitle={product?.name}
      submitLabel={mut.isPending ? "Saving…" : "Set cost"}
      onSubmit={submit}
      submitting={mut.isPending}
    >
      <FormSection title="Unit cost">
        <View style={styles.currentRow}>
          <Text style={styles.currentLabel}>Current average cost</Text>
          <Text style={styles.currentValue}>
            {currentCost != null ? `$${currentCost.toFixed(4)}` : "No cost set"}
          </Text>
        </View>
        <FormField label="Cost per unit ($)" hint="What one unit costs you to buy.">
          <FormTextInput
            value={unitCost}
            onChangeText={setUnitCost}
            placeholder="0.0000"
            keyboardType="decimal-pad"
          />
        </FormField>
      </FormSection>

      <FormSection title="Options">
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>Also rewrite open stock lots</Text>
            <Text style={styles.switchHint}>For FIFO/LIFO products only.</Text>
          </View>
          <Switch value={applyToLots} onValueChange={setApplyToLots} />
        </View>
        <FormField label="Notes">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. opening cost from supplier price list"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            style={{ minHeight: 80 }}
          />
        </FormField>
      </FormSection>

      <View style={styles.helpRow}>
        <Ionicons name="information-circle-outline" size={14} color={ios.label2} />
        <Text style={styles.help}>
          Recorded as an audited COST_BASIS movement. Future purchases keep updating the average
          from here.
        </Text>
      </View>
    </FormSheet>
  );
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
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  switchLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  switchHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  helpRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  help: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
});
