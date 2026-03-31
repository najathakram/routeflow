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
  useReportArAging,
  useReportSalesByCustomer,
  useReportSalesByItem,
  useReportPaymentsReceived,
  useReportProfitLoss,
  useReportCustomerBalance,
} from "../../lib/api/admin";

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

type ReportKey = "ar_aging" | "sales_customer" | "sales_item" | "payments" | "pl" | "customer_balance";

interface ReportDef {
  key: ReportKey;
  label: string;
  description: string;
  icon: string;
  color: string;
  bg: string;
}

const REPORTS: ReportDef[] = [
  { key: "ar_aging", label: "AR Aging", description: "Outstanding invoices by age bucket", icon: "time-outline", color: "#dc2626", bg: "#fee2e2" },
  { key: "sales_customer", label: "Sales by Customer", description: "Revenue breakdown per customer", icon: "people-outline", color: "#2563EB", bg: "#dbeafe" },
  { key: "sales_item", label: "Sales by Item", description: "Revenue breakdown per product", icon: "cube-outline", color: "#db2777", bg: "#fce7f3" },
  { key: "payments", label: "Payments Received", description: "All payments recorded", icon: "card-outline", color: "#16a34a", bg: "#dcfce7" },
  { key: "pl", label: "Profit & Loss", description: "Revenue, COGS, expenses, net income", icon: "trending-up-outline", color: "#7c3aed", bg: "#ede9fe" },
  { key: "customer_balance", label: "Customer Balances", description: "Outstanding balance per customer", icon: "wallet-outline", color: "#d97706", bg: "#fef3c7" },
];

function ReportList({ onSelect }: { onSelect: (k: ReportKey) => void }) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Reports</Text>
      </View>
      <View style={{ padding: 16 }}>
        <Text style={styles.pageSubtitle}>Select a report to view</Text>
        {REPORTS.map(r => (
          <Pressable key={r.key} style={styles.reportCard} onPress={() => onSelect(r.key)}>
            <View style={[styles.reportIcon, { backgroundColor: r.bg }]}>
              <Ionicons name={r.icon as any} size={22} color={r.color} />
            </View>
            <View style={styles.reportInfo}>
              <Text style={styles.reportLabel}>{r.label}</Text>
              <Text style={styles.reportDesc}>{r.description}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.backHeader}>
      <Pressable onPress={onBack} style={styles.backBtn}>
        <Ionicons name="arrow-back" size={20} color={colors.navy.DEFAULT} />
      </Pressable>
      <Text style={styles.backTitle}>{title}</Text>
    </View>
  );
}

function TableView({ columns, rows, isLoading }: { columns: { label: string; key: string; right?: boolean; width?: number }[]; rows: any[]; isLoading: boolean }) {
  if (isLoading) return <ActivityIndicator color="#2563EB" style={{ marginTop: 32 }} />;
  if (rows.length === 0) return <Text style={styles.emptyText}>No data available</Text>;
  return (
    <ScrollView style={{ flex: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={styles.tHead}>
            {columns.map(c => (
              <Text key={c.key} style={[styles.tHeadCell, { width: c.width ?? 100, textAlign: c.right ? "right" : "left" }]}>{c.label}</Text>
            ))}
          </View>
          {rows.map((row, i) => (
            <View key={i} style={[styles.tRow, i % 2 === 1 && styles.tRowAlt]}>
              {columns.map(c => (
                <Text key={c.key} style={[styles.tCell, { width: c.width ?? 100, textAlign: c.right ? "right" : "left" }]} numberOfLines={1}>{row[c.key] ?? "—"}</Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

function ArAgingReport({ onBack }: { onBack: () => void }) {
  const { data = [], isLoading } = useReportArAging();
  const totalAmount = data.reduce((s, r) => s + Number(r.total), 0);
  return (
    <View style={{ flex: 1 }}>
      <BackHeader title="AR Aging" onBack={onBack} />
      <View style={styles.summaryBar}>
        <Text style={styles.summaryLabel}>Total Outstanding</Text>
        <Text style={styles.summaryValue}>{usd(totalAmount)}</Text>
      </View>
      <TableView
        isLoading={isLoading}
        columns={[
          { label: "Bucket", key: "bucket", width: 130 },
          { label: "Invoices", key: "count", right: true, width: 80 },
          { label: "Amount", key: "totalFmt", right: true, width: 100 },
        ]}
        rows={data.map(r => ({ ...r, totalFmt: usd(Number(r.total)) }))}
      />
    </View>
  );
}

function SalesByCustomerReport({ onBack }: { onBack: () => void }) {
  const { data = [], isLoading } = useReportSalesByCustomer();
  const total = data.reduce((s, r) => s + Number(r.totalRevenue), 0);
  return (
    <View style={{ flex: 1 }}>
      <BackHeader title="Sales by Customer" onBack={onBack} />
      <View style={styles.summaryBar}>
        <Text style={styles.summaryLabel}>Total Revenue</Text>
        <Text style={styles.summaryValue}>{usd(total)}</Text>
      </View>
      <TableView
        isLoading={isLoading}
        columns={[
          { label: "Customer", key: "customerName", width: 150 },
          { label: "Orders", key: "orderCount", right: true, width: 70 },
          { label: "Revenue", key: "revFmt", right: true, width: 100 },
        ]}
        rows={data.map(r => ({ ...r, revFmt: usd(Number(r.totalRevenue)) }))}
      />
    </View>
  );
}

function SalesByItemReport({ onBack }: { onBack: () => void }) {
  const { data = [], isLoading } = useReportSalesByItem();
  const total = data.reduce((s, r) => s + Number(r.totalRevenue), 0);
  return (
    <View style={{ flex: 1 }}>
      <BackHeader title="Sales by Item" onBack={onBack} />
      <View style={styles.summaryBar}>
        <Text style={styles.summaryLabel}>Total Revenue</Text>
        <Text style={styles.summaryValue}>{usd(total)}</Text>
      </View>
      <TableView
        isLoading={isLoading}
        columns={[
          { label: "Product", key: "productName", width: 150 },
          { label: "Units", key: "unitsSold", right: true, width: 70 },
          { label: "Revenue", key: "revFmt", right: true, width: 100 },
        ]}
        rows={data.map(r => ({ ...r, revFmt: usd(Number(r.totalRevenue)) }))}
      />
    </View>
  );
}

function PaymentsReport({ onBack }: { onBack: () => void }) {
  const { data = [], isLoading } = useReportPaymentsReceived();
  const total = data.reduce((s, r) => s + Number(r.amount), 0);
  return (
    <View style={{ flex: 1 }}>
      <BackHeader title="Payments Received" onBack={onBack} />
      <View style={styles.summaryBar}>
        <Text style={styles.summaryLabel}>Total Collected</Text>
        <Text style={styles.summaryValue}>{usd(total)}</Text>
      </View>
      <TableView
        isLoading={isLoading}
        columns={[
          { label: "Invoice", key: "invoiceNumber", width: 100 },
          { label: "Customer", key: "customerName", width: 130 },
          { label: "Method", key: "method", width: 80 },
          { label: "Amount", key: "amtFmt", right: true, width: 100 },
        ]}
        rows={data.map(r => ({ ...r, amtFmt: usd(Number(r.amount)) }))}
      />
    </View>
  );
}

function PLReport({ onBack }: { onBack: () => void }) {
  const { data, isLoading } = useReportProfitLoss();
  return (
    <View style={{ flex: 1 }}>
      <BackHeader title="Profit & Loss" onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        {isLoading ? <ActivityIndicator color="#2563EB" style={{ marginTop: 32 }} /> : !data ? <Text style={styles.emptyText}>No data</Text> : (
          <View style={styles.plCard}>
            {[
              { label: "Revenue", value: usd(Number(data.revenue)), color: "#16a34a", border: false },
              { label: "COGS", value: usd(Number(data.cogs)), color: "#dc2626", border: false },
              { label: "Gross Profit", value: usd(Number(data.grossProfit)), color: "#2563EB", border: true },
              { label: "Expenses", value: usd(Number(data.expenses)), color: "#dc2626", border: false },
              { label: "Net Income", value: usd(Number(data.netIncome)), color: data.netIncome >= 0 ? "#16a34a" : "#dc2626", border: true },
              { label: "Gross Margin", value: Number(data.grossMarginPct).toFixed(1) + "%", color: "#7c3aed", border: false },
            ].map(item => (
              <View key={item.label} style={[styles.plRow, item.border && styles.plRowBorder]}>
                <Text style={[styles.plLabel, item.border && styles.plLabelBold]}>{item.label}</Text>
                <Text style={[styles.plValue, { color: item.color }, item.border && styles.plLabelBold]}>{item.value}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function CustomerBalanceReport({ onBack }: { onBack: () => void }) {
  const { data = [], isLoading } = useReportCustomerBalance();
  const totalBalance = data.reduce((s, r) => s + Number(r.balance), 0);
  return (
    <View style={{ flex: 1 }}>
      <BackHeader title="Customer Balances" onBack={onBack} />
      <View style={styles.summaryBar}>
        <Text style={styles.summaryLabel}>Total Outstanding</Text>
        <Text style={styles.summaryValue}>{usd(totalBalance)}</Text>
      </View>
      <TableView
        isLoading={isLoading}
        columns={[
          { label: "Customer", key: "customerName", width: 140 },
          { label: "Invoiced", key: "invFmt", right: true, width: 100 },
          { label: "Paid", key: "paidFmt", right: true, width: 100 },
          { label: "Balance", key: "balFmt", right: true, width: 100 },
        ]}
        rows={data.map(r => ({ ...r, invFmt: usd(Number(r.totalInvoiced)), paidFmt: usd(Number(r.totalPaid)), balFmt: usd(Number(r.balance)) }))}
      />
    </View>
  );
}

export default function AdminReportsScreen() {
  const [selected, setSelected] = useState<ReportKey | null>(null);
  const onBack = () => setSelected(null);

  if (!selected) return <ReportList onSelect={setSelected} />;
  if (selected === "ar_aging") return <ArAgingReport onBack={onBack} />;
  if (selected === "sales_customer") return <SalesByCustomerReport onBack={onBack} />;
  if (selected === "sales_item") return <SalesByItemReport onBack={onBack} />;
  if (selected === "payments") return <PaymentsReport onBack={onBack} />;
  if (selected === "pl") return <PLReport onBack={onBack} />;
  if (selected === "customer_balance") return <CustomerBalanceReport onBack={onBack} />;
  return null;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  header: { backgroundColor: "#fff", paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  pageSubtitle: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#94a3b8", marginBottom: 16 },
  reportCard: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 12,
    padding: 16, marginBottom: 10, gap: 14,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  reportIcon: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  reportInfo: { flex: 1 },
  reportLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.navy.DEFAULT, marginBottom: 2 },
  reportDesc: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#64748b" },
  backHeader: {
    flexDirection: "row", alignItems: "center", backgroundColor: "#fff",
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#e2e8f0", gap: 12,
  },
  backBtn: { padding: 4 },
  backTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: colors.navy.DEFAULT },
  summaryBar: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    backgroundColor: "#fff", paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "#e2e8f0",
  },
  summaryLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#64748b" },
  summaryValue: { fontSize: 16, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  tHead: { flexDirection: "row", backgroundColor: "#f8fafc", paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  tHeadCell: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#94a3b8", textTransform: "uppercase", paddingRight: 8 },
  tRow: { flexDirection: "row", paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  tRowAlt: { backgroundColor: "#f8fafc" },
  tCell: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#334155", paddingRight: 8 },
  emptyText: { textAlign: "center", color: "#94a3b8", fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 48 },
  plCard: {
    backgroundColor: "#fff", borderRadius: 12, padding: 20,
    shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  plRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  plRowBorder: { borderTopWidth: 2, borderTopColor: "#e2e8f0", marginTop: 4, paddingTop: 18 },
  plLabel: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#475569" },
  plLabelBold: { fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  plValue: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
