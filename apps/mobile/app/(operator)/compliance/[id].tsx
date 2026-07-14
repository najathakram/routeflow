import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { KpiCard, ListGroup, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useTrackedCategory, useTrackedSubcategories } from "../../../lib/api/tracked-categories";
import {
  fetchRegulatedFilingUrl,
  useRegulatedFilings,
  useRegulatedLedger,
  usePrepareFiling,
} from "../../../lib/api/regulated";
import {
  fmtMoney,
  lastCompletedPeriod,
  taxRuleLabel,
  treatmentLabel,
} from "../../../lib/regulated-format";
import { RegulatedFilingsList } from "../../../components/RegulatedFilingsList";
import { shareCsv } from "../../../lib/share-pdf";
import { showToast } from "../../../lib/toast";

export default function RegulatedSectionDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: section, isLoading } = useTrackedCategory(id);
  const { data: subs = [] } = useTrackedSubcategories(id);
  const { data: filings = [] } = useRegulatedFilings(id);
  const prepare = usePrepareFiling();
  const [preparing, setPreparing] = useState(false);

  // Year-to-date ledger for this section. `to` is left unbounded so today's sales
  // are included (the endpoint treats `to` as inclusive, which would otherwise
  // clip the current day) — mirrors web exactly.
  const now = new Date();
  const year = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1-12
  const from = `${year}-01-01`;
  const ledger = useRegulatedLedger({ category: id, from }, { enabled: !!id });

  const ledgerRows = ledger.data?.rows;
  const monthKey = `${year}-${String(currentMonth).padStart(2, "0")}`;
  const thisMonth = ledgerRows?.find((r) => r.periodBucket === monthKey);

  // Reverse-chronological month list (most recent first) — mobile has no chart
  // lib, so this replaces web's bar chart (see plan "Key facts").
  const monthlyRows = useMemo(() => {
    const byMonth = new Map((ledgerRows ?? []).map((r) => [r.periodBucket, r]));
    const out: { key: string; label: string; netSales: number; categoryTax: number }[] = [];
    for (let m = currentMonth; m >= 1; m--) {
      const key = `${year}-${String(m).padStart(2, "0")}`;
      const r = byMonth.get(key);
      out.push({
        key,
        label: new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString(undefined, {
          month: "short",
          timeZone: "UTC",
        }),
        netSales: r?.netSales ?? 0,
        categoryTax: r?.categoryTax ?? 0,
      });
    }
    return out;
  }, [ledgerRows, year, currentMonth]);

  const activeSubs = subs.filter((s) => s.active);

  if (isLoading || !section) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Section"
          leading={<NavBackButton label="Regulated" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const handlePrepare = () => {
    const { year: py, index } = lastCompletedPeriod(section.reportCadence);
    setPreparing(true);
    prepare.mutate(
      { trackedCategoryId: section.id, cadence: section.reportCadence, year: py, index },
      {
        onSuccess: async (filing) => {
          showToast(`Filing prepared · ${filing.periodKey}`);
          try {
            const url = await fetchRegulatedFilingUrl(filing.id, "csv");
            await shareCsv({
              url,
              filename: `${section.name}-${filing.periodKey}.csv`,
              dialogTitle: "Share filing",
            });
          } catch {
            /* saved; the filing row below still offers the CSV share */
          }
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Failed to prepare filing"),
        onSettled: () => setPreparing(false),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={section.name}
        leading={<NavBackButton label="Regulated" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.headBlock}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Ionicons name="shield-checkmark-outline" size={18} color={ios.brand} />
            <Text style={styles.headName}>{section.name}</Text>
            {section.requiresLicense ? (
              <Pill variant="orange" small>
                License
              </Pill>
            ) : null}
            {!section.active ? (
              <Pill variant="gray" small>
                Off
              </Pill>
            ) : null}
          </View>
          <Text style={styles.headSub}>
            {taxRuleLabel(section)} · {treatmentLabel(section.invoiceTreatment)} ·{" "}
            {section.reportCadence.toLowerCase()} filings
          </Text>
        </View>

        <View style={styles.kpiRow}>
          <KpiCard
            icon={<Ionicons name="cash-outline" size={18} color={ios.system.greenInk} />}
            iconBg={ios.system.greenWash}
            value={ledger.isLoading ? "…" : fmtMoney(thisMonth?.netSales ?? 0)}
            label="Net sales (month)"
          />
          <KpiCard
            icon={<Ionicons name="receipt-outline" size={18} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            value={ledger.isLoading ? "…" : fmtMoney(thisMonth?.categoryTax ?? 0)}
            label="Tax (month)"
          />
        </View>
        <View style={[styles.kpiRow, { marginTop: 12 }]}>
          <KpiCard
            icon={<Ionicons name="cube-outline" size={18} color={ios.brand} />}
            iconBg={ios.brandWash}
            value={String(section.productCount)}
            label="Regulated Products"
          />
          <KpiCard
            icon={<Ionicons name="document-text-outline" size={18} color={ios.system.purpleInk} />}
            iconBg={ios.system.purpleWash}
            value={String(filings.length)}
            label="Filings"
          />
        </View>

        <ListGroup header={`MONTHLY · ${year}`}>
          {monthlyRows.map((r) => (
            <View key={r.key} style={styles.monthRow}>
              <Text style={styles.monthLabel}>{r.label}</Text>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.monthNet}>{fmtMoney(r.netSales)}</Text>
                <Text style={styles.monthTax}>Tax {fmtMoney(r.categoryTax)}</Text>
              </View>
            </View>
          ))}
        </ListGroup>

        {activeSubs.length > 0 ? (
          <View style={styles.chipSection}>
            <Text style={styles.chipHeader}>SUBCATEGORIES</Text>
            <View style={styles.chipWrap}>
              {activeSubs.map((s) => (
                <View key={s.id} style={styles.chip}>
                  <Ionicons name="pricetag-outline" size={12} color={ios.brand} />
                  <Text style={styles.chipText}>{s.name}</Text>
                  <Text style={styles.chipCount}>{s.productCount}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.prepareRow}>
          <Text style={styles.prepareText}>Prepare a filing for the last completed period.</Text>
          <Pressable style={styles.prepareBtn} onPress={handlePrepare} disabled={preparing}>
            {preparing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.prepareBtnText}>Prepare filing</Text>
            )}
          </Pressable>
        </View>

        <RegulatedFilingsList
          filings={filings}
          emptyHint="No filings prepared yet. Use Prepare filing above to generate one for the last completed period."
        />

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 10 },
  headBlock: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, gap: 4 },
  headName: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  headSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  kpiRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, marginTop: 12 },
  monthRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: ios.bgElev,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  monthLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  monthNet: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  monthTax: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2 },
  chipSection: { marginHorizontal: 16, marginBottom: 20 },
  chipHeader: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.78,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  chipCount: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  prepareRow: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  prepareText: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  prepareBtn: {
    backgroundColor: ios.brand,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 120,
    alignItems: "center",
  },
  prepareBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
