import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import {
  useAnalyticsRevenue,
  useAnalyticsTopProducts,
  useAnalyticsTopCustomers,
  useAnalyticsRoutePerformance,
  useAnalyticsDriverPerformance,
  useAnalyticsGrossMargin,
  useAnalyticsSalesByCategory,
  useAnalyticsInventoryTurnover,
  useAnalyticsDeadStock,
  useAnalyticsDso,
  useAnalyticsAov,
} from "../../lib/api/admin";

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const pct = (n: number) => n.toFixed(1) + "%";

const TABS = ["Revenue", "Products", "Customers", "Operations"] as const;
type Tab = typeof TABS[number];

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
      {TABS.map((t) => (
        <Pressable key={t} onPress={() => onChange(t)} style={[styles.tab, active === t && styles.tabActive]}>
          <Text style={[styles.tabText, active === t && styles.tabTextActive]}>{t}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function KpiCard({ label, value, icon, color }: { label: string; value: string; icon: string; color: string }) {
  return (
    <View style={styles.kpiCard}>
      <View style={[styles.kpiIcon, { backgroundColor: color + "20" }]}>
        <Ionicons name={icon as any} size={18} color={color} />
      </View>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function BarRow({ label, value, max, formatted }: { label: string; value: number; max: number; formatted: string }) {
  const width = max > 0 ? (value / max) * 100 : 0;
  return (
    <View style={styles.barRow}>
      <Text style={styles.barLabel} numberOfLines={1}>{label}</Text>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${Math.min(width, 100)}%` }]} />
      </View>
      <Text style={styles.barValue}>{formatted}</Text>
    </View>
  );
}

function ProgressRow({ label, value, subtitle }: { label: string; value: number; subtitle: string }) {
  const color = value >= 90 ? "#16a34a" : value >= 70 ? "#d97706" : "#dc2626";
  return (
    <View style={styles.progressRow}>
      <View style={styles.progressHeader}>
        <Text style={styles.progressLabel} numberOfLines={1}>{label}</Text>
        <Text style={[styles.progressValue, { color }]}>{pct(value)}</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.min(value, 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.progressSub}>{subtitle}</Text>
    </View>
  );
}

function RevenueTab() {
  const { data: revenue = [], isLoading: rLoading } = useAnalyticsRevenue();
  const { data: gm, isLoading: gmLoading } = useAnalyticsGrossMargin();
  const { data: dso } = useAnalyticsDso();
  const { data: aov } = useAnalyticsAov();
  const { data: cats = [] } = useAnalyticsSalesByCategory();

  const maxRevenue = Math.max(...revenue.map(r => r.revenue), 1);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={styles.kpiRow}>
        <KpiCard label="Avg Order Value" value={aov ? usd(aov.aov) : "—"} icon="cart-outline" color="#2563EB" />
        <KpiCard label="Days to Get Paid" value={dso ? dso.dso.toFixed(0) + "d" : "—"} icon="time-outline" color="#d97706" />
        <KpiCard label="Gross Margin" value={gm ? pct(gm.grossMarginPct) : "—"} icon="trending-up-outline" color="#16a34a" />
      </View>

      <SectionCard title="Revenue Trend">
        {rLoading ? (
          <ActivityIndicator color="#2563EB" />
        ) : revenue.length === 0 ? (
          <Text style={styles.emptyText}>No revenue data</Text>
        ) : (
          revenue.map(r => (
            <BarRow key={r.period} label={r.period} value={r.revenue} max={maxRevenue} formatted={usd(r.revenue)} />
          ))
        )}
      </SectionCard>

      {gm && !gmLoading && (
        <SectionCard title="Gross Margin Breakdown">
          {[
            { label: "Revenue", value: usd(gm.revenue), color: "#2563EB" },
            { label: "COGS", value: usd(gm.cogs), color: "#dc2626" },
            { label: "Gross Profit", value: usd(gm.grossProfit), color: "#16a34a" },
            { label: "Margin %", value: pct(gm.grossMarginPct), color: "#d97706" },
          ].map(item => (
            <View key={item.label} style={styles.metricRow}>
              <Text style={styles.metricLabel}>{item.label}</Text>
              <Text style={[styles.metricValue, { color: item.color }]}>{item.value}</Text>
            </View>
          ))}
        </SectionCard>
      )}

      {cats.length > 0 && (
        <SectionCard title="Sales by Category">
          {cats.map((c, i) => (
            <View key={i} style={styles.metricRow}>
              <Text style={styles.metricLabel}>{c.category}</Text>
              <Text style={styles.metricValue}>{usd(c.revenue)}</Text>
            </View>
          ))}
        </SectionCard>
      )}
    </ScrollView>
  );
}

function ProductsTab() {
  const { data: topProducts = [], isLoading } = useAnalyticsTopProducts("revenue");
  const { data: turnover = [] } = useAnalyticsInventoryTurnover();
  const { data: deadStock = [] } = useAnalyticsDeadStock();

  const maxRev = Math.max(...topProducts.map(p => p.totalRevenue), 1);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
      <SectionCard title="Top Products by Revenue">
        {isLoading ? <ActivityIndicator color="#2563EB" /> : topProducts.length === 0 ? <Text style={styles.emptyText}>No data</Text> : (
          topProducts.slice(0, 10).map(p => (
            <BarRow key={p.id} label={p.name} value={p.totalRevenue} max={maxRev} formatted={usd(p.totalRevenue)} />
          ))
        )}
      </SectionCard>

      {turnover.length > 0 && (
        <SectionCard title="Inventory Turnover">
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHead, { flex: 2 }]}>Product</Text>
            <Text style={[styles.tableHead, { flex: 1, textAlign: "right" }]}>Sold</Text>
            <Text style={[styles.tableHead, { flex: 1, textAlign: "right" }]}>Stock</Text>
            <Text style={[styles.tableHead, { flex: 1, textAlign: "right" }]}>Rate</Text>
          </View>
          {turnover.slice(0, 8).map(t => (
            <View key={t.id} style={styles.tableRow}>
              <Text style={[styles.tableCell, { flex: 2 }]} numberOfLines={1}>{t.name}</Text>
              <Text style={[styles.tableCell, { flex: 1, textAlign: "right" }]}>{t.unitsSold}</Text>
              <Text style={[styles.tableCell, { flex: 1, textAlign: "right" }]}>{t.currentStock}</Text>
              <Text style={[styles.tableCell, { flex: 1, textAlign: "right" }]}>{t.turnoverRate.toFixed(1)}x</Text>
            </View>
          ))}
        </SectionCard>
      )}

      {deadStock.length > 0 && (
        <SectionCard title="Dead Stock (30+ days inactive)">
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHead, { flex: 2 }]}>Product</Text>
            <Text style={[styles.tableHead, { flex: 1, textAlign: "right" }]}>Stock</Text>
            <Text style={[styles.tableHead, { flex: 1, textAlign: "right" }]}>Days</Text>
          </View>
          {deadStock.slice(0, 8).map(d => (
            <View key={d.id} style={styles.tableRow}>
              <Text style={[styles.tableCell, { flex: 2 }]} numberOfLines={1}>{d.name}</Text>
              <Text style={[styles.tableCell, { flex: 1, textAlign: "right" }]}>{d.currentStock}</Text>
              <Text style={[styles.tableCell, { flex: 1, textAlign: "right", color: "#dc2626" }]}>{d.daysInactive}d</Text>
            </View>
          ))}
        </SectionCard>
      )}
    </ScrollView>
  );
}

function CustomersTab() {
  const { data: topCustomers = [], isLoading } = useAnalyticsTopCustomers();
  const maxRev = Math.max(...topCustomers.map(c => c.totalRevenue), 1);

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
      <SectionCard title="Top Customers by Revenue">
        {isLoading ? <ActivityIndicator color="#2563EB" /> : topCustomers.length === 0 ? <Text style={styles.emptyText}>No data</Text> : (
          topCustomers.slice(0, 10).map(c => (
            <BarRow key={c.id} label={c.name} value={c.totalRevenue} max={maxRev} formatted={usd(c.totalRevenue)} />
          ))
        )}
      </SectionCard>

      {topCustomers.length > 0 && (
        <SectionCard title="Customer Details">
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHead, { flex: 2 }]}>Customer</Text>
            <Text style={[styles.tableHead, { flex: 1, textAlign: "right" }]}>Orders</Text>
            <Text style={[styles.tableHead, { flex: 1, textAlign: "right" }]}>Revenue</Text>
          </View>
          {topCustomers.slice(0, 10).map(c => (
            <View key={c.id} style={styles.tableRow}>
              <Text style={[styles.tableCell, { flex: 2 }]} numberOfLines={1}>{c.name}</Text>
              <Text style={[styles.tableCell, { flex: 1, textAlign: "right" }]}>{c.orderCount}</Text>
              <Text style={[styles.tableCell, { flex: 1, textAlign: "right" }]}>{usd(c.totalRevenue)}</Text>
            </View>
          ))}
        </SectionCard>
      )}
    </ScrollView>
  );
}

function OperationsTab() {
  const { data: routes = [], isLoading: rLoading } = useAnalyticsRoutePerformance();
  const { data: drivers = [], isLoading: dLoading } = useAnalyticsDriverPerformance();

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
      <SectionCard title="Route Performance">
        {rLoading ? <ActivityIndicator color="#2563EB" /> : routes.length === 0 ? <Text style={styles.emptyText}>No route data</Text> : (
          routes.map(r => (
            <ProgressRow
              key={r.id}
              label={r.name}
              value={r.completionRate}
              subtitle={`${r.completedRuns}/${r.totalRuns} runs completed`}
            />
          ))
        )}
      </SectionCard>

      <SectionCard title="Driver Performance">
        {dLoading ? <ActivityIndicator color="#2563EB" /> : drivers.length === 0 ? <Text style={styles.emptyText}>No driver data</Text> : (
          drivers.map(d => (
            <ProgressRow
              key={d.id}
              label={d.name}
              value={d.completionRate}
              subtitle={`${d.completedDeliveries}/${d.totalDeliveries} deliveries`}
            />
          ))
        )}
      </SectionCard>
    </ScrollView>
  );
}

export default function AdminAnalyticsScreen() {
  const [activeTab, setActiveTab] = useState<Tab>("Revenue");

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Analytics</Text>
      </View>
      <TabBar active={activeTab} onChange={setActiveTab} />
      <View style={styles.content}>
        {activeTab === "Revenue" && <RevenueTab />}
        {activeTab === "Products" && <ProductsTab />}
        {activeTab === "Customers" && <CustomersTab />}
        {activeTab === "Operations" && <OperationsTab />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  header: { backgroundColor: "#fff", paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  tabBar: { backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e2e8f0", maxHeight: 52 },
  tab: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: "transparent", marginBottom: -1 },
  tabActive: { borderBottomColor: "#2563EB" },
  tabText: { fontSize: 14, fontFamily: "Inter_500Medium", color: "#94a3b8" },
  tabTextActive: { color: "#2563EB", fontFamily: "Inter_600SemiBold" },
  content: { flex: 1, paddingTop: 16, paddingHorizontal: 16 },
  kpiRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  kpiCard: {
    flex: 1, backgroundColor: "#fff", borderRadius: 12, padding: 12, alignItems: "center",
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  kpiIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  kpiValue: { fontSize: 15, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT, textAlign: "center" },
  kpiLabel: { fontSize: 11, fontFamily: "Inter_400Regular", color: "#94a3b8", textAlign: "center", marginTop: 2 },
  card: {
    backgroundColor: "#fff", borderRadius: 12, padding: 16, marginBottom: 16,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  cardTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.navy.DEFAULT, marginBottom: 14 },
  barRow: { flexDirection: "row", alignItems: "center", marginBottom: 10, gap: 8 },
  barLabel: { width: 80, fontSize: 12, fontFamily: "Inter_400Regular", color: "#475569" },
  barTrack: { flex: 1, height: 6, backgroundColor: "#f1f5f9", borderRadius: 3, overflow: "hidden" },
  barFill: { height: "100%", backgroundColor: "#2563EB", borderRadius: 3 },
  barValue: { width: 60, fontSize: 12, fontFamily: "Inter_500Medium", color: "#1e293b", textAlign: "right" },
  metricRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  metricLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#475569" },
  metricValue: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: colors.navy.DEFAULT },
  tableHeader: { flexDirection: "row", paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: "#e2e8f0", marginBottom: 4 },
  tableHead: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#94a3b8", textTransform: "uppercase" },
  tableRow: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#f8fafc" },
  tableCell: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#334155" },
  progressRow: { marginBottom: 14 },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  progressLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#334155", flex: 1 },
  progressValue: { fontSize: 13, fontFamily: "Inter_700Bold" },
  progressTrack: { height: 6, backgroundColor: "#f1f5f9", borderRadius: 3, overflow: "hidden", marginBottom: 4 },
  progressFill: { height: "100%", borderRadius: 3 },
  progressSub: { fontSize: 11, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  emptyText: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#94a3b8", textAlign: "center", paddingVertical: 16 },
});
