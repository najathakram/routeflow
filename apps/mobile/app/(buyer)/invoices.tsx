import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { format, parseISO } from "date-fns";
import { buyerApiClient } from "../../lib/buyer-auth";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BuyerInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total: string | number;
  dueDate: string | null;
  createdAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  DRAFT:   { label: "Draft",   color: "#64748b", bg: "#f8fafc" },
  SENT:    { label: "Sent",    color: "#2563eb", bg: "#eff6ff" },
  VIEWED:  { label: "Viewed",  color: "#2563eb", bg: "#eff6ff" },
  PARTIAL: { label: "Partial", color: "#d97706", bg: "#fffbeb" },
  PAID:    { label: "Paid",    color: "#16a34a", bg: "#f0fdf4" },
  OVERDUE: { label: "Overdue", color: "#dc2626", bg: "#fef2f2" },
  VOID:    { label: "Void",    color: "#94a3b8", bg: "#f8fafc" },
};

function StatusChip({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, color: "#64748b", bg: "#f8fafc" };
  return (
    <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.statusChipText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

// ─── Invoice row ──────────────────────────────────────────────────────────────

function InvoiceRow({ invoice }: { invoice: BuyerInvoice }) {
  const dateLabel = format(parseISO(invoice.createdAt), "MMM d, yyyy");
  const dueLabel = invoice.dueDate
    ? format(parseISO(invoice.dueDate), "MMM d")
    : null;

  return (
    <View style={styles.card}>
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
              color={invoice.status === "OVERDUE" ? "#dc2626" : "#64748b"}
            />
            <Text
              style={[
                styles.dueText,
                invoice.status === "OVERDUE" && { color: "#dc2626" },
              ]}
            >
              Due {dueLabel}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function BuyerInvoicesScreen() {
  const [invoices, setInvoices] = useState<BuyerInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { data } = await buyerApiClient.get<PaginatedResponse<BuyerInvoice>>(
        "/buyer/invoices",
      );
      setInvoices(data.data ?? []);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Failed to load invoices.";
      setError(typeof msg === "string" ? msg : "Failed to load invoices.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Ionicons name="cloud-offline-outline" size={40} color="#cbd5e1" />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={invoices}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      style={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4f46e5" />
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Ionicons name="document-text-outline" size={48} color="#cbd5e1" />
          <Text style={styles.emptyTitle}>No invoices yet</Text>
          <Text style={styles.emptySubtitle}>
            Invoices from this seller will appear here.
          </Text>
        </View>
      }
      renderItem={({ item }) => <InvoiceRow invoice={item} />}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  listContent: {
    padding: 16,
    gap: 10,
    flexGrow: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f8fafc",
    gap: 12,
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#dc2626",
    textAlign: "center",
    paddingHorizontal: 32,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: "#1B3A5C",
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
    paddingHorizontal: 32,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
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
    color: "#1B3A5C",
  },
  dateText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
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
    color: "#1B3A5C",
  },
  duePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  dueText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
});
