import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { KpiCard, ListGroup, ListRow, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useTobaccoOverview,
  useTobaccoInventory,
  useTobaccoReports,
  useGenerateTobaccoReport,
  fetchTobaccoReportUrl,
  useHasAddon,
  TOBACCO_ADDON,
  type TobaccoReport,
} from "../../../lib/api/tobacco";
import { sharePdf } from "../../../lib/share-pdf";
import { showToast } from "../../../lib/toast";

function fmt(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function previousMonth(): { year: number; month: number } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return m === 0 ? { year: y - 1, month: 12 } : { year: y, month: m };
}

export default function TobaccoScreen() {
  const router = useRouter();
  const enabled = useHasAddon(TOBACCO_ADDON);
  const { data: overview, isLoading } = useTobaccoOverview();
  const { data: inventory = [] } = useTobaccoInventory();
  const { data: reports = [] } = useTobaccoReports();
  const generate = useGenerateTobaccoReport();

  if (!enabled) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Tobacco"
          leading={<NavBackButton label="More" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <Ionicons name="shield-outline" size={36} color={ios.gray[3]} />
          <Text style={styles.emptyTitle}>Tobacco compliance is not enabled</Text>
          <Text style={styles.emptyText}>
            Ask your platform administrator to enable the Tobacco Dealer Compliance add-on.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const prev = previousMonth();
  const prevLabel = `${prev.year}-${String(prev.month).padStart(2, "0")}`;

  const onGenerate = () =>
    generate.mutate(prev, {
      onSuccess: () => showToast(`Report ${prevLabel} generated`),
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });

  const onShare = async (report: TobaccoReport) => {
    try {
      const url = await fetchTobaccoReportUrl(report.id, "pdf");
      await sharePdf({
        url,
        filename: `tobacco-report-${report.periodYear}-${String(report.periodMonth).padStart(2, "0")}.pdf`,
        dialogTitle: "Share tobacco report",
      });
    } catch (e: any) {
      showToast(e?.message ?? "Could not share the report.");
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Tobacco"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : (
          <>
            {/* This month KPIs */}
            <View style={styles.kpiRow}>
              <KpiCard
                icon={<Ionicons name="leaf-outline" size={18} color={ios.system.orangeInk} />}
                iconBg={ios.system.orangeWash}
                value={fmt(overview?.purchases.totalValue)}
                label="Purchases (month)"
              />
              <KpiCard
                icon={<Ionicons name="cash-outline" size={18} color={ios.system.greenInk} />}
                iconBg={ios.system.greenWash}
                value={fmt(overview?.sales.totalValue)}
                label={`Sales · ${fmt(overview?.sales.totalTax)} tax`}
              />
            </View>
            <View style={[styles.kpiRow, { marginTop: 12 }]}>
              <KpiCard
                icon={<Ionicons name="cube-outline" size={18} color={ios.brand} />}
                iconBg={ios.brandWash}
                value={String(overview?.flaggedProductCount ?? 0)}
                label="Flagged products"
              />
              <KpiCard
                icon={<Ionicons name="archive-outline" size={18} color={ios.system.purpleInk} />}
                iconBg={ios.system.purpleWash}
                value={fmt(overview?.inventory.totalValue)}
                label="Tobacco stock value"
              />
            </View>

            {/* Reports */}
            <ListGroup header="MONTHLY REPORTS">
              <View style={styles.generateRow}>
                <Text style={styles.generateText}>Last completed month: {prevLabel}</Text>
                <Pressable
                  style={styles.generateBtn}
                  onPress={onGenerate}
                  disabled={generate.isPending}
                >
                  {generate.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.generateBtnText}>Generate</Text>
                  )}
                </Pressable>
              </View>
              {reports.slice(0, 12).map((r) => (
                <ListRow
                  key={r.id}
                  icon={
                    <Ionicons
                      name={r.status === "GENERATED" ? "document-text-outline" : "alert-circle"}
                      size={16}
                      color={r.status === "GENERATED" ? ios.brand : ios.system.redInk}
                    />
                  }
                  iconBg={r.status === "GENERATED" ? ios.brandWash : ios.system.redWash}
                  title={`${r.periodYear}-${String(r.periodMonth).padStart(2, "0")}`}
                  subtitle={
                    r.status === "GENERATED"
                      ? `Sales ${fmt(r.totalSalesValue)} · Tax ${fmt(r.totalTaxCollected)}${r.generationCount > 1 ? ` · regen ×${r.generationCount}` : ""}`
                      : (r.errorMessage ?? "Generation failed")
                  }
                  onPress={r.status === "GENERATED" ? () => void onShare(r) : undefined}
                  chevron={r.status === "GENERATED"}
                />
              ))}
              {reports.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>No reports yet.</Text>
                </View>
              ) : null}
            </ListGroup>

            {/* Inventory */}
            <ListGroup header="TOBACCO INVENTORY">
              {inventory.map((p) => (
                <ListRow
                  key={p.id}
                  icon={<Ionicons name="pricetag-outline" size={16} color={ios.system.orangeInk} />}
                  iconBg={ios.system.orangeWash}
                  title={p.name}
                  subtitle={`${p.currentStock} ${p.unit}${p.totalValue != null ? ` · ${fmt(p.totalValue)}` : ""}`}
                  onPress={() => router.push(`/(operator)/products/${p.id}`)}
                  chevron
                  trailing={
                    p.averageCost == null ? <Pill variant="orange">No cost</Pill> : undefined
                  }
                />
              ))}
              {inventory.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>
                    No products flagged as tobacco yet — flag them from a product page.
                  </Text>
                </View>
              ) : null}
            </ListGroup>

            <View style={{ height: 32 }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 10 },
  kpiRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, marginTop: 8 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  emptyRow: { padding: 16 },
  generateRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  generateText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  generateBtn: {
    backgroundColor: ios.brand,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    minWidth: 84,
    alignItems: "center",
  },
  generateBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
