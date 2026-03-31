import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useAdminReturns, AdminReturn } from "../../../lib/api/admin";

const STATUS_FILTERS = ["ALL", "PENDING", "APPROVED", "REJECTED", "PROCESSED"];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fef3c7", text: "#92400e" },
  APPROVED: { bg: "#d1fae5", text: "#065f46" },
  REJECTED: { bg: "#fee2e2", text: "#991b1b" },
  PROCESSED: { bg: "#f1f5f9", text: "#475569" },
};

const REASON_LABELS: Record<string, string> = {
  DAMAGED: "Damaged",
  QUALITY_ISSUE: "Quality Issue",
  WRONG_ITEM: "Wrong Item",
  EXCESS_ORDER: "Excess Order",
  OTHER: "Other",
};

export default function AdminReturnsScreen() {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);

  const params = {
    status: statusFilter === "ALL" ? undefined : statusFilter,
    page,
    limit: 20,
  };

  const { data, isLoading, isError, refetch, isFetching } = useAdminReturns(params);
  const returns = data?.data ?? [];
  const hasMore = data?.meta ? page * 20 < (data.meta.total ?? 0) : false;

  const renderItem = ({ item }: { item: AdminReturn }) => {
    const sc = STATUS_COLORS[item.status] ?? { bg: "#f1f5f9", text: "#475569" };
    const reasonLabel = REASON_LABELS[item.reason] ?? item.reason;

    return (
      <View style={styles.row}>
        <View style={[styles.returnIcon, { backgroundColor: "#fff7ed" }]}>
          <Ionicons name="arrow-undo-outline" size={18} color="#ea580c" />
        </View>
        <View style={styles.rowInfo}>
          <View style={styles.rowTopLine}>
            <Text style={styles.returnNumber}>
              {item.returnNumber ?? item.id.slice(0, 8)}
            </Text>
          </View>
          <Text style={styles.customerName}>
            {item.customer?.businessName ?? "—"}
          </Text>
          {item.order?.orderNumber && (
            <Text style={styles.orderRef}>Order: {item.order.orderNumber}</Text>
          )}
          <View style={styles.reasonRow}>
            <Ionicons name="information-circle-outline" size={13} color="#94a3b8" />
            <Text style={styles.reasonText}>{reasonLabel}</Text>
          </View>
          <Text style={styles.dateText}>
            {new Date(item.createdAt).toLocaleDateString()}
          </Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
          <Text style={[styles.statusText, { color: sc.text }]}>{item.status}</Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
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
            <Text style={[styles.chipText, statusFilter === s && styles.chipTextActive]}>
              {s}
            </Text>
          </Pressable>
        )}
      />

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 48 }} color="#2563EB" />
      ) : isError ? (
        <View style={styles.emptyState}>
          <Ionicons name="cloud-offline-outline" size={40} color="#cbd5e1" />
          <Text style={styles.emptyText}>Failed to load returns</Text>
          <Pressable style={styles.retryBtn} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : returns.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="arrow-undo-outline" size={40} color="#cbd5e1" />
          <Text style={styles.emptyText}>No returns found</Text>
        </View>
      ) : (
        <FlatList
          data={returns}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && page === 1}
              onRefresh={() => { setPage(1); refetch(); }}
            />
          }
          ListFooterComponent={
            hasMore ? (
              <Pressable
                style={styles.loadMoreBtn}
                onPress={() => setPage((p) => p + 1)}
              >
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
  filtersContainer: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 100,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  chipActive: { backgroundColor: "#2563EB", borderColor: "#2563EB" },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#64748b" },
  chipTextActive: { color: "#fff" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
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
    gap: 12,
  },
  returnIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  rowInfo: { flex: 1, gap: 2 },
  rowTopLine: { flexDirection: "row", alignItems: "center" },
  returnNumber: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  customerName: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#475569" },
  orderRef: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  reasonRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  reasonText: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#64748b" },
  dateText: { fontSize: 11, fontFamily: "Inter_400Regular", color: "#94a3b8", marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100, alignSelf: "flex-start" },
  statusText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingBottom: 80,
  },
  emptyText: { fontSize: 15, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "#2563EB",
    borderRadius: 8,
  },
  retryText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 14 },
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
  loadMoreText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#2563EB" },
});
