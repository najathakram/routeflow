import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useRouter } from "expo-router";
import {
  useAdminFinanceDashboard,
  useAdminInvoices,
  AdminInvoice,
} from "../../../lib/api/admin";

const INVOICE_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  DRAFT: { bg: "#f1f5f9", text: "#475569" },
  SENT: { bg: "#dbeafe", text: "#1e40af" },
  PARTIAL: { bg: "#fef9c3", text: "#854d0e" },
  PAID: { bg: "#d1fae5", text: "#065f46" },
  OVERDUE: { bg: "#fee2e2", text: "#991b1b" },
  VOID: { bg: "#f1f5f9", text: "#94a3b8" },
};

interface KpiCardProps {
  label: string;
  value: string;
  icon: string;
  iconBg: string;
  iconColor: string;
}

function KpiCard({ label, value, icon, iconBg, iconColor }: KpiCardProps) {
  return (
    <View style={styles.kpiCard}>
      <View style={[styles.kpiIcon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon as any} size={20} color={iconColor} />
      </View>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

export default function AdminFinanceScreen() {
  const router = useRouter();
  const { data: finance, isLoading: financeLoading, refetch: refetchFinance } = useAdminFinanceDashboard();
  const { data: invoicesData, isLoading: invoicesLoading, refetch: refetchInvoices } = useAdminInvoices({ limit: 5 });

  const recentInvoices = invoicesData?.data ?? [];

  const onRefresh = () => {
    refetchFinance();
    refetchInvoices();
  };

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={onRefresh} />
      }
    >
      {/* KPI Cards */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Financial Overview</Text>
        {financeLoading ? (
          <ActivityIndicator style={{ marginVertical: 24 }} color="#2563EB" />
        ) : (
          <View style={styles.kpiGrid}>
            <KpiCard
              label="Revenue"
              value={`$${Number(finance?.revenue ?? 0).toFixed(2)}`}
              icon="trending-up-outline"
              iconBg="#d1fae5"
              iconColor="#059669"
            />
            <KpiCard
              label="Outstanding"
              value={`$${Number(finance?.totalOutstanding ?? 0).toFixed(2)}`}
              icon="alert-circle-outline"
              iconBg="#fee2e2"
              iconColor="#dc2626"
            />
            <KpiCard
              label="Collected"
              value={`$${Number(finance?.totalCollected ?? 0).toFixed(2)}`}
              icon="checkmark-circle-outline"
              iconBg="#dbeafe"
              iconColor="#2563EB"
            />
            <KpiCard
              label="Invoiced"
              value={`$${Number(finance?.totalInvoiced ?? 0).toFixed(2)}`}
              icon="document-text-outline"
              iconBg="#ede9fe"
              iconColor="#7c3aed"
            />
            <KpiCard
              label="Expenses"
              value={`$${Number(finance?.expenses ?? 0).toFixed(2)}`}
              icon="card-outline"
              iconBg="#fff7ed"
              iconColor="#ea580c"
            />
            <KpiCard
              label="Net Income"
              value={`$${Number(finance?.netIncome ?? 0).toFixed(2)}`}
              icon="cash-outline"
              iconBg="#fce7f3"
              iconColor="#db2777"
            />
          </View>
        )}
      </View>

      {/* Navigation Buttons */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Invoice Management</Text>
        <Pressable
          style={styles.navBtn}
          onPress={() => router.push("/(admin)/finance/invoices" as any)}
        >
          <View style={[styles.navBtnIcon, { backgroundColor: "#dbeafe" }]}>
            <Ionicons name="document-text-outline" size={20} color="#2563EB" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.navBtnTitle}>All Invoices</Text>
            <Text style={styles.navBtnSub}>View and manage all invoices</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
        </Pressable>
        <Pressable
          style={[styles.navBtn, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.surface.border }]}
          onPress={() => router.push({ pathname: "/(admin)/finance/invoices", params: { status: "OVERDUE" } } as any)}
        >
          <View style={[styles.navBtnIcon, { backgroundColor: "#fee2e2" }]}>
            <Ionicons name="alert-circle-outline" size={20} color="#dc2626" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.navBtnTitle}>Overdue Invoices</Text>
            <Text style={styles.navBtnSub}>Invoices past their due date</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
        </Pressable>
        <Pressable
          style={[styles.navBtn, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.surface.border }]}
          onPress={() => router.push({ pathname: "/(admin)/finance/invoices", params: { status: "PARTIAL" } } as any)}
        >
          <View style={[styles.navBtnIcon, { backgroundColor: "#fef9c3" }]}>
            <Ionicons name="time-outline" size={20} color="#854d0e" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.navBtnTitle}>Partial Payments</Text>
            <Text style={styles.navBtnSub}>Invoices with partial payment</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
        </Pressable>
      </View>

      {/* Recent Invoices */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Recent Invoices</Text>
          <Pressable onPress={() => router.push("/(admin)/finance/invoices" as any)}>
            <Text style={styles.seeAll}>See all</Text>
          </Pressable>
        </View>
        {invoicesLoading ? (
          <ActivityIndicator style={{ marginVertical: 16 }} color="#2563EB" />
        ) : recentInvoices.length === 0 ? (
          <View style={styles.emptyMini}>
            <Text style={styles.emptyMiniText}>No invoices yet</Text>
          </View>
        ) : (
          recentInvoices.map((invoice, index) => {
            const sc = INVOICE_STATUS_COLORS[invoice.status] ?? { bg: "#f1f5f9", text: "#475569" };
            return (
              <Pressable
                key={invoice.id}
                style={[styles.invoiceRow, index === 0 && { borderTopWidth: 0 }]}
                onPress={() => router.push(`/(admin)/finance/${invoice.id}` as any)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
                  <Text style={styles.invoiceCustomer}>
                    {invoice.customer?.businessName ?? "—"}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
                    <Text style={[styles.statusText, { color: sc.text }]}>
                      {invoice.status}
                    </Text>
                  </View>
                  <Text style={styles.invoiceAmount}>
                    ${Number(invoice.total).toFixed(2)}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  section: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    marginBottom: 12,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  seeAll: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#2563EB",
    marginBottom: 8,
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  kpiCard: {
    width: "47%",
    backgroundColor: "#f8fafc",
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  kpiIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  kpiValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  kpiLabel: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  navBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 12,
  },
  navBtnIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  navBtnTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  navBtnSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: 1,
  },
  invoiceRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  invoiceNumber: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  invoiceCustomer: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  statusText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  invoiceAmount: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  emptyMini: { paddingVertical: 16, alignItems: "center" },
  emptyMiniText: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#94a3b8" },
});
