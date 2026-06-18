import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { KpiCard, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  useAdminFinanceDashboard,
  useAnalyticsAov,
  useAnalyticsDso,
  useAnalyticsTopCustomers,
  useAnalyticsTopProducts,
} from "../../../lib/api/admin";

function fmt(n: number | undefined): string {
  if (n == null) return "—";
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`;
}

export default function AnalyticsScreen() {
  const router = useRouter();
  const { data: finance, isLoading: financeLoading } = useAdminFinanceDashboard();
  const { data: dso } = useAnalyticsDso();
  const { data: aov } = useAnalyticsAov();
  const { data: topProducts } = useAnalyticsTopProducts();
  const { data: topCustomers } = useAnalyticsTopCustomers();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Analytics"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          {financeLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : (
            <>
              <View style={styles.kpiRow}>
                <KpiCard
                  icon={<Ionicons name="cash-outline" size={18} color={ios.system.greenInk} />}
                  iconBg={ios.system.greenWash}
                  value={fmt(finance?.revenue)}
                  label="Revenue"
                />
                <KpiCard
                  icon={
                    <Ionicons name="trending-down-outline" size={18} color={ios.system.redInk} />
                  }
                  iconBg={ios.system.redWash}
                  value={fmt(finance?.expenses)}
                  label="Expenses"
                />
              </View>
              <View style={styles.kpiRow}>
                <KpiCard
                  icon={<Ionicons name="trending-up-outline" size={18} color={ios.brand} />}
                  iconBg={ios.brandWash}
                  value={fmt(finance?.netIncome)}
                  label="Net income"
                />
                <KpiCard
                  icon={<Ionicons name="time-outline" size={18} color={ios.system.orangeInk} />}
                  iconBg={ios.system.orangeWash}
                  value={fmt(finance?.totalOutstanding)}
                  label="A/R outstanding"
                />
              </View>
              <View style={styles.kpiRow}>
                <KpiCard
                  icon={<Ionicons name="calendar-outline" size={18} color={ios.system.purpleInk} />}
                  iconBg={ios.system.purpleWash}
                  value={dso?.dso != null ? `${Math.round(dso.dso)}d` : "—"}
                  label="Days sales outstanding"
                />
                <KpiCard
                  icon={<Ionicons name="receipt-outline" size={18} color={ios.brand} />}
                  iconBg={ios.brandWash}
                  value={aov?.aov ? fmt(aov.aov) : "—"}
                  label="Avg order value"
                />
              </View>
            </>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Top products</Text>
            {topProducts && topProducts.length > 0 ? (
              topProducts.slice(0, 5).map((p, i) => (
                <View
                  key={p.id}
                  style={[
                    styles.lineRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <Text style={styles.lineRank}>{i + 1}</Text>
                  <Text style={styles.lineName} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={styles.lineValue}>{fmt(p.totalRevenue)}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.empty}>Not enough data yet.</Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Top customers</Text>
            {topCustomers && topCustomers.length > 0 ? (
              topCustomers.slice(0, 5).map((c, i) => (
                <View
                  key={c.id}
                  style={[
                    styles.lineRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <Text style={styles.lineRank}>{i + 1}</Text>
                  <Text style={styles.lineName} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={styles.lineValue}>{fmt(c.totalRevenue)}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.empty}>Not enough data yet.</Text>
            )}
          </View>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  kpiRow: { flexDirection: "row", gap: 12 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  lineRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  lineRank: {
    width: 22,
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  lineName: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  lineValue: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 6 },
});
