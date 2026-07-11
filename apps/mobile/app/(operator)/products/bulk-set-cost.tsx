import { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useBulkSetCostBasis, useInventoryValuation } from "../../../lib/api/inventory";
import { showToast } from "../../../lib/toast";

/**
 * Set the cost basis for every product that currently has no cost, in one pass.
 * Rows are seeded from the valuation's missingCostProducts; only filled rows are
 * submitted. Mirrors web's BulkSetCostModal.
 */
export default function BulkSetCostScreen() {
  const router = useRouter();
  const { data: valuation, isLoading } = useInventoryValuation();
  const mut = useBulkSetCostBasis();
  const [costs, setCosts] = useState<Record<string, string>>({});

  const missing = useMemo(() => valuation?.missingCostProducts ?? [], [valuation]);
  const filledCount = missing.filter((p) => {
    const n = parseFloat(costs[p.id] ?? "");
    return Number.isFinite(n) && n > 0;
  }).length;

  const submit = () => {
    const items = missing
      .map((p) => ({ productId: p.id, unitCost: parseFloat(costs[p.id] ?? "") }))
      .filter((i) => Number.isFinite(i.unitCost) && i.unitCost > 0);
    if (items.length === 0) {
      showToast("Enter a cost for at least one product.");
      return;
    }
    mut.mutate(
      { items },
      {
        onSuccess: (res) => {
          showToast(`Set cost on ${res.updated} product${res.updated === 1 ? "" : "s"}`);
          router.back();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }

  return (
    <FormSheet
      title="Set missing costs"
      subtitle={missing.length ? `${missing.length} without a cost` : undefined}
      submitLabel={mut.isPending ? "Saving…" : filledCount > 0 ? `Set ${filledCount}` : "Set costs"}
      submitting={mut.isPending}
      submitDisabled={filledCount === 0}
      onSubmit={submit}
    >
      {missing.length === 0 ? (
        <FormSection title="All set">
          <Text style={styles.done}>Every product already has a cost. 🎉</Text>
        </FormSection>
      ) : (
        <FormSection title="Per-piece cost">
          {missing.map((p) => (
            <FormField key={p.id} label={p.name}>
              <FormTextInput
                value={costs[p.id] ?? ""}
                onChangeText={(v) => setCosts((c) => ({ ...c, [p.id]: v }))}
                placeholder="0.00"
                keyboardType="decimal-pad"
              />
            </FormField>
          ))}
        </FormSection>
      )}
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: ios.bg, alignItems: "center", justifyContent: "center" },
  done: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
});
