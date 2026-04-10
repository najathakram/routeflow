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

interface BuyerOrder {
  id: string;
  orderNumber: string;
  status: string;
  total: string | number;
  createdAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  PENDING:          { label: "Pending",        color: "#d97706", bg: "#fffbeb" },
  CONFIRMED:        { label: "Confirmed",       color: "#2563eb", bg: "#eff6ff" },
  OUT_FOR_DELIVERY: { label: "Out for Delivery",color: "#7c3aed", bg: "#f5f3ff" },
  DELIVERED:        { label: "Delivered",       color: "#16a34a", bg: "#f0fdf4" },
  CANCELLED:        { label: "Cancelled",       color: "#dc2626", bg: "#fef2f2" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, color: "#64748b", bg: "#f8fafc" };
  return (
    <View style={[styles.statusBadge, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

// ─── Order row ────────────────────────────────────────────────────────────────

function OrderRow({ order }: { order: BuyerOrder }) {
  const dateLabel = format(parseISO(order.createdAt), "MMM d, yyyy");

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.cardLeft}>
          <Text style={styles.orderNumber}>{order.orderNumber}</Text>
          <Text style={styles.dateText}>{dateLabel}</Text>
        </View>
        <StatusBadge status={order.status} />
      </View>
      <View style={styles.cardBottom}>
        <Text style={styles.totalAmount}>${Number(order.total).toFixed(2)}</Text>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function BuyerOrdersScreen() {
  const [orders, setOrders] = useState<BuyerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { data } = await buyerApiClient.get<PaginatedResponse<BuyerOrder>>(
        "/buyer/orders",
      );
      setOrders(data.data ?? []);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Failed to load orders.";
      setError(typeof msg === "string" ? msg : "Failed to load orders.");
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
      data={orders}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      style={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4f46e5" />
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Ionicons name="receipt-outline" size={48} color="#cbd5e1" />
          <Text style={styles.emptyTitle}>No orders yet</Text>
          <Text style={styles.emptySubtitle}>
            Orders placed with this seller will appear here.
          </Text>
        </View>
      }
      renderItem={({ item }) => <OrderRow order={item} />}
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
  orderNumber: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#1B3A5C",
  },
  dateText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  statusText: {
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
});
