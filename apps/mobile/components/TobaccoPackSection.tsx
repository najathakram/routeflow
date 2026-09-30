import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, ListRow, Pill } from "@routeflow/ui/mobile/ios";
import {
  useTobaccoInventory,
  useTobaccoReports,
  useGenerateTobaccoReport,
  fetchTobaccoReportUrl,
  type TobaccoReport,
} from "../lib/api/tobacco";
import { sharePdf } from "../lib/share-pdf";
import { showToast } from "../lib/toast";

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

/**
 * The Tobacco compliance pack's reports + inventory groups, transplanted from the
 * retired standalone apps/mobile/app/(operator)/tobacco/index.tsx (2026-08-24
 * consolidation into the Regulated Items hub). No KPI row here — the hosting
 * section screen already renders its own. No addon check inside — the parent
 * gates the mount on useHasAddon(TOBACCO_ADDON).
 */
export function TobaccoPackSection() {
  const router = useRouter();
  const { data: inventory = [] } = useTobaccoInventory();
  const { data: reports = [] } = useTobaccoReports();
  const generate = useGenerateTobaccoReport();

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
    <>
      <ListGroup header="MONTHLY REPORTS">
        <View style={styles.generateRow}>
          <Text style={styles.generateText}>Last completed month: {prevLabel}</Text>
          <Pressable style={styles.generateBtn} onPress={onGenerate} disabled={generate.isPending}>
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
            trailing={p.averageCost == null ? <Pill variant="orange">No cost</Pill> : undefined}
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
    </>
  );
}

const styles = StyleSheet.create({
  emptyRow: { padding: 16 },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
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
