import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { KpiCard, ListGroup, ListRow, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useTrackedCategories } from "../../../lib/api/tracked-categories";
import { useRegulatedFilings } from "../../../lib/api/regulated";
import { useHasAddon, useTobaccoOverview, TOBACCO_ADDON } from "../../../lib/api/tobacco";
import { fmtMoney, taxRuleLabel, treatmentLabel } from "../../../lib/regulated-format";
import { RegulatedFilingsList } from "../../../components/RegulatedFilingsList";

export default function ComplianceHubScreen() {
  const router = useRouter();
  const { data: sections = [], isLoading } = useTrackedCategories();
  const hasTobacco = useHasAddon(TOBACCO_ADDON);
  // Mirrors the existing app/(operator)/tobacco/index.tsx precedent: this hook has
  // no `enabled` option on mobile, so it's called unconditionally — only the
  // *display* below is gated on hasTobacco.
  const { data: overview } = useTobaccoOverview();
  const { data: filings = [] } = useRegulatedFilings();

  const activeCount = sections.filter((s) => s.active).length;
  const regulatedProducts = sections.reduce((sum, s) => sum + (s.productCount ?? 0), 0);
  const categoryName = (id: string) => sections.find((s) => s.id === id)?.name ?? "—";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="Regulated Items" />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : (
          <>
            <View style={styles.kpiRow}>
              <KpiCard
                icon={<Ionicons name="layers-outline" size={18} color={ios.brand} />}
                iconBg={ios.brandWash}
                value={
                  sections.length > activeCount
                    ? `${activeCount} / ${sections.length}`
                    : String(activeCount)
                }
                label="Tracked Sections"
              />
              <KpiCard
                icon={<Ionicons name="cube-outline" size={18} color={ios.system.greenInk} />}
                iconBg={ios.system.greenWash}
                value={String(regulatedProducts)}
                label="Regulated Products"
              />
            </View>
            <View style={[styles.kpiRow, { marginTop: 12 }]}>
              <KpiCard
                icon={<Ionicons name="receipt-outline" size={18} color={ios.system.orangeInk} />}
                iconBg={ios.system.orangeWash}
                value={hasTobacco && overview ? fmtMoney(overview.sales.totalTax) : "—"}
                label="Tax (this month)"
              />
              <KpiCard
                icon={
                  <Ionicons name="document-text-outline" size={18} color={ios.system.purpleInk} />
                }
                iconBg={ios.system.purpleWash}
                value={String(filings.length)}
                label="Filings"
              />
            </View>

            <ListGroup header="SECTIONS">
              {sections.map((s) => (
                <ListRow
                  key={s.id}
                  icon={<Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />}
                  iconBg={ios.brandWash}
                  title={s.name}
                  subtitle={`${taxRuleLabel(s)} · ${treatmentLabel(s.invoiceTreatment)} · ${s.productCount} ${s.productCount === 1 ? "product" : "products"}`}
                  trailing={
                    !s.active ? (
                      <Pill variant="gray" small>
                        Off
                      </Pill>
                    ) : s.requiresLicense ? (
                      <Pill variant="orange" small>
                        License
                      </Pill>
                    ) : undefined
                  }
                  onPress={() => router.push(`/(operator)/compliance/${s.id}`)}
                  chevron
                />
              ))}
              {sections.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>
                    No regulated sections yet. Tobacco is added automatically for tenants that sell
                    it.
                  </Text>
                </View>
              ) : null}
            </ListGroup>

            <RegulatedFilingsList filings={filings} showCategory categoryName={categoryName} />

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
  emptyRow: { padding: 16 },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
});
