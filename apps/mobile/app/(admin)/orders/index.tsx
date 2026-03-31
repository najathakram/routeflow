import { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useRouter } from "expo-router";
import { useAdminOrders, AdminOrder } from "../../../lib/api/admin";
import { useDebounce } from "../../../lib/use-debounce";

const STATUS_FILTERS = [
  "ALL",
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fef3c7", text: "#92400e" },
  CONFIRMED: { bg: "#dbeafe", text: "#1e40af" },
  OUT_FOR_DELIVERY: { bg: "#ede9fe", text: "#5b21b6" },
  DELIVERED: { bg: "#d1fae5", text: "#065f46" },
  CANCELLED: { bg: "#f1f5f9", text: "#475569" },
};

const STATUS_LABELS: Record<string, string> = {
  OUT_FOR_DELIVERY: "OUT",
};

export default function AdminOrdersScreen() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 300);

  const params = {
    status: statusFilter === "ALL" ? undefined : statusFilter,
    search: debouncedSearch || undefined,
    page,
    limit: 20,
  };

  const { data, isLoading, isError, refetch, isFetching } = useAdminOrders(params);
  const orders = data?.data ?? [];
  const hasMore = data?.meta ? page * 20 < (data.meta.total ?? 0) : false;

  const onRefresh = useCallback(() => {
    setPage(1);
    refetch();
  }, [refetch]);

  const loadMore = () => {
    if (hasMore && !isFetching) {
      setPage((p) => p + 1);
    }
  };

  const renderItem = ({ item }: { item: AdminOrder }) => {
    const sc = STATUS_COLORS[item.status] ?? { bg: "#f1f5f9", text: "#475569" };
    const label = STATUS_LABELS[item.status] ?? item.status;
    return (
      <Pressable
        style={styles.row}
        onPress={() => router.push(`/(admin)/orders/${item.id}` as any)}
      >
        <View style={styles.rowLeft}>
          <View style={styles.rowTopLine}>
            <Text style={styles.orderNumber}>{item.orderNumber}</Text>
            {item.urgent && (
              <View style={styles.urgentBadge}>
                <Ionicons name="flash" size={10} color="#dc2626" />
                <Text style={styles.urgentText}>Urgent</Text>
              </View>
            )}
          </View>
          <Text style={styles.customerName}>
            {item.customer?.businessName ?? "—"}
          </Text>
          <Text style={styles.orderDate}>
            {new Date(item.createdAt).toLocaleDateString()}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.statusText, { color: sc.text }]}>{label}</Text>
          </View>
          <Text style={styles.amount}>${Number(item.total).toFixed(2)}</Text>
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Search */}
      <View style={styles.searchContainer}>
        <Ionicons
          name="search-outline"
          size={18}
          color="#94a3b8"
          style={styles.searchIcon}
        />
        <TextInput
          style={styles.searchInput}
          placeholder="Search orders..."
          placeholderTextColor="#94a3b8"
          value={search}
          onChangeText={(t) => {
            setSearch(t);
            setPage(1);
          }}
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color="#94a3b8" />
          </Pressable>
        )}
      </View>

      {/* Status filter chips */}
      <FlatList
        horizontal
        data={STATUS_FILTERS}
        keyExtractor={(s) => s}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filtersContainer}
        renderItem={({ item: s }) => (
          <Pressable
            style={[styles.chip, statusFilter === s && styles.chipActive]}
            onPress={() => {
              setStatusFilter(s);
              setPage(1);
            }}
          >
            <Text
              style={[styles.chipText, statusFilter === s && styles.chipTextActive]}
            >
              {STATUS_LABELS[s] ?? s}
            </Text>
          </Pressable>
        )}
      />

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 48 }} color="#2563EB" />
      ) : isError ? (
        <View style={styles.emptyState}>
          <Ionicons name="cloud-offline-outline" size={40} color="#cbd5e1" />
          <Text style={styles.emptyText}>Failed to load orders</Text>
          <Pressable style={styles.retryBtn} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : orders.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="receipt-outline" size={40} color="#cbd5e1" />
          <Text style={styles.emptyText}>No orders found</Text>
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={isFetching && page === 1} onRefresh={onRefresh} />
          }
          ListFooterComponent={
            hasMore ? (
              <Pressable style={styles.loadMoreBtn} onPress={loadMore}>
                {isFetching ? (
                  <ActivityIndicator size="small" color="#2563EB" />
                ) : (
                  <Text style={styles.loadMoreText}>Load More</Text>
                )}
              </Pressable>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.surface.border,
    height: 44,
  },
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  filtersContainer: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 100,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  chipActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
  },
  chipText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  chipTextActive: {
    color: "#fff",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  rowLeft: { flex: 1, gap: 3 },
  rowTopLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  orderNumber: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  urgentBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: "#fee2e2",
    borderRadius: 100,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  urgentText: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: "#dc2626" },
  customerName: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  orderDate: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  rowRight: { alignItems: "flex-end", gap: 6 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  statusText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  amount: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingBottom: 80,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "#2563EB",
    borderRadius: 8,
  },
  retryText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  loadMoreBtn: {
    marginHorizontal: 16,
    marginTop: 4,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  loadMoreText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#2563EB",
  },
});
