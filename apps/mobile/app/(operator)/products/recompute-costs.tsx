import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useRecomputeCosts, type RecomputeCostsResult } from "../../../lib/api/inventory";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function money(n: number | null): string {
  return n == null ? "—" : `$${Number(n).toFixed(2)}`;
}

/**
 * Recompute average costs by replaying stock movements. Runs a dry-run on mount
 * (preview only), then the operator can Apply. Mirrors web's RecomputeModal.
 *
 * B562 (interim mitigation, owner-approved): the warehouse tab no longer links to
 * this screen — the recompute is blind to raw order decrements and can silently
 * rewrite a tenant's whole inventory valuation while destroying the `stockAfter`
 * evidence needed to detect it (see the comment on
 * InventoryController.recomputeCosts). This screen and its route are left in
 * place, unreachable from the UI, until B562's root cause is fixed.
 */
export default function RecomputeCostsScreen() {
  const router = useRouter();
  const mut = useRecomputeCosts();
  const [preview, setPreview] = useState<RecomputeCostsResult | null>(null);

  useEffect(() => {
    mut.mutate(
      { dryRun: true },
      {
        onSuccess: (res) => setPreview(res),
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Failed."),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = () => {
    confirm(
      "Apply recompute?",
      "This writes the recomputed average costs and backfills movement snapshots.",
      () =>
        mut.mutate(
          { dryRun: false },
          {
            onSuccess: (res) => {
              showToast(`Updated ${res.updated} product${res.updated === 1 ? "" : "s"}`);
              router.back();
            },
            onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Failed."),
          },
        ),
      { confirmText: "Apply" },
    );
  };

  const loadingPreview = mut.isPending && !preview;
  const changed = (preview?.results ?? []).filter((r) => r.oldAvgCost !== r.newAvgCost);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Recompute costs"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16 }}>
        {loadingPreview ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
            <Text style={styles.hint}>Previewing…</Text>
          </View>
        ) : preview ? (
          <>
            <View style={styles.tiles}>
              <Stat label="Processed" value={preview.processed} />
              <Stat label="Would change" value={changed.length} tone="brand" />
              <Stat label="No history" value={preview.noHistory.length} tone="muted" />
            </View>

            {changed.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Changes</Text>
                {changed.slice(0, 50).map((r) => (
                  <View key={r.productId} style={styles.row}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text style={styles.rowCost}>
                      {money(r.oldAvgCost)} →{" "}
                      <Text style={styles.rowNew}>{money(r.newAvgCost)}</Text>
                    </Text>
                  </View>
                ))}
                {changed.length > 50 ? (
                  <Text style={styles.more}>+{changed.length - 50} more…</Text>
                ) : null}
              </View>
            ) : (
              <Text style={styles.hint}>No cost changes — everything is already up to date.</Text>
            )}

            <Pressable
              style={[
                styles.applyBtn,
                (mut.isPending || changed.length === 0) && styles.applyDisabled,
              ]}
              disabled={mut.isPending || changed.length === 0}
              onPress={apply}
            >
              <Text style={styles.applyText}>{mut.isPending ? "Applying…" : "Apply changes"}</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.hint}>Couldn’t load the preview.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "brand" | "muted" }) {
  return (
    <View style={styles.tile}>
      <Text
        style={[
          styles.tileValue,
          tone === "brand" && { color: ios.brand },
          tone === "muted" && { color: ios.label2 },
        ]}
      >
        {value}
      </Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 10 },
  hint: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  tiles: { flexDirection: "row", gap: 10, marginBottom: 14 },
  tile: {
    flex: 1,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    gap: 4,
  },
  tileValue: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label },
  tileLabel: { fontSize: 11, fontFamily: "Inter_500Medium", color: ios.label2 },
  card: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, marginBottom: 14 },
  cardTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2, marginBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  rowName: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  rowCost: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  rowNew: { fontFamily: "Inter_700Bold", color: ios.label },
  more: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 6 },
  applyBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  applyDisabled: { opacity: 0.5 },
  applyText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
