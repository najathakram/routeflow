import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyInvoices, type Invoice, type InvoiceStatus } from "../../../lib/api/invoices";
import { NetworkError } from "../../../components/NetworkError";

type FilterKey = "ALL" | "UNPAID" | "PARTIAL" | "PAID";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "ALL",     label: "All" },
  { key: "UNPAID",  label: "Unpaid" },
  { key: "PARTIAL", label: "Partial" },
  { key: "PAID",    label: "Paid" },
];

function matchesInvoiceFilter(invoice: Invoice, filter: FilterKey): boolean {
  if (filter === "ALL") return true;
  if (filter === "UNPAID") return invoice.status === "SENT" || invoice.status === "VIEWED" || invoice.status === "OVERDUE";
  if (filter === "PARTIAL") return invoice.status === "PARTIAL";
  if (filter === "PAID") return invoice.status === "PAID";
  return true;
}

const STATUS_CONFIG: Record<
  InvoiceStatus,
  { label: string; color: string; bg: string }
> = {
  DRAFT:   { label: "Draft",    color: "#64748b",               bg: colors.surface.raised },
  SENT:    { label: "Sent",     color: colors.brand[700],        bg: colors.brand[50] },
  VIEWED:  { label: "Viewed",   color: colors.brand[700],        bg: colors.brand[50] },
  PARTIAL: { label: "Partial",  color: colors.warning.DEFAULT,   bg: colors.warning.bg },
  PAID:    { label: "Paid",     color: colors.success.DEFAULT,   bg: colors.success.bg },
  OVERDUE: { label: "Overdue",  color: colors.danger.DEFAULT,    bg: colors.danger.bg },
  VOID:    { label: "Void",     color: "#94a3b8",                bg: colors.surface.raised },
};

function StatusChip({ status }: { status: InvoiceStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.DRAFT;
  return (
    <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.statusChipText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const dateLabel = format(parseISO(invoice.createdAt), "MMM d, yyyy");
  const dueLabel = invoice.dueDate
    ? format(parseISO(invoice.dueDate), "MMM d")
    : null;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/(customer)/invoices/${invoice.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`Invoice ${invoice.invoiceNumber}`}
    >
      <View style={styles.cardTop}>
        <View style={styles.cardLeft}>
          <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
          <Text style={styles.dateText}>{dateLabel}</Text>
        </View>
        <StatusChip status={invoice.status} />
      </View>

      <View style={styles.cardBottom}>
        <Text style={styles.totalAmount}>${Number(invoice.total).toFixed(2)}</Text>
        {dueLabel && invoice.status !== "PAID" && invoice.status !== "VOID" ? (
          <View style={styles.duePill}>
            <Ionicons
              name="calendar-outline"
              size={13}
              color={invoice.status === "OVERDUE" ? colors.danger.DEFAULT : "#64748b"}
            />
            <Text
              style={[
                styles.dueText,
                invoice.status === "OVERDUE" && { color: colors.danger.DEFAULT },
              ]}
            >
              Due {dueLabel}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function InvoicesScreen() {
  const { data, isLoading, isError, refetch } = useMyInvoices();
  const [activeFilter, setActiveFilter] = useState<FilterKey>("ALL");

  const allInvoices = data?.data ?? [];
  const filtered = useMemo(
    () => allInvoices.filter((inv) => matchesInvoiceFilter(inv, activeFilter)),
    [allInvoices, activeFilter],
  );

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Invoices" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Invoices" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Invoices" }} />
      <View style={styles.container}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterBar}
          contentContainerStyle={styles.filterContent}
        >
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              style={[styles.filterChip, activeFilter === f.key && styles.filterChipActive]}
              onPress={() => setActiveFilter(f.key)}
            >
              <Text style={[styles.filterChipText, activeFilter === f.key && styles.filterChipTextActive]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="document-text-outline" size={48} color="#cbd5e1" />
              <Text style={styles.emptyText}>
                {activeFilter === "ALL" ? "No invoices yet." : `No ${activeFilter.toLowerCase()} invoices.`}
              </Text>
            </View>
          }
          renderItem={({ item }) => <InvoiceRow invoice={item} />}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  filterBar: {
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    flexGrow: 0,
  },
  filterContent: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  filterChipActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  filterChipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  filterChipTextActive: { color: colors.brand[500] },
  list: { backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 10,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: {
    alignItems: "center",
    paddingTop: 64,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardLeft: { gap: 2 },
  invoiceNumber: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  dateText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  statusChipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  cardBottom: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  totalAmount: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  duePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  dueText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
});
