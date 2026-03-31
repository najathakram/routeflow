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
import { useAdminDrivers, AdminDriver } from "../../../lib/api/admin";

const STATUS_FILTERS = ["ALL", "ACTIVE", "INACTIVE"];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  ACTIVE: { bg: "#d1fae5", text: "#065f46" },
  INACTIVE: { bg: "#f1f5f9", text: "#475569" },
};

export default function AdminDriversScreen() {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);

  const params = {
    status: statusFilter === "ALL" ? undefined : statusFilter,
    page,
    limit: 20,
  };

  const { data, isLoading, isError, refetch, isFetching } = useAdminDrivers(params);
  const drivers = data?.data ?? [];
  const hasMore = data?.meta ? page * 20 < (data.meta.total ?? 0) : false;

  const renderItem = ({ item }: { item: AdminDriver }) => {
    const sc = STATUS_COLORS[item.status] ?? { bg: "#f1f5f9", text: "#475569" };
    const displayName = item.user
      ? `${item.user.firstName} ${item.user.lastName}`
      : item.id;
    const initials = item.user
      ? `${item.user.firstName[0] ?? ""}${item.user.lastName[0] ?? ""}`.toUpperCase()
      : "DR";
    const vehicle = [item.vehicleMake, item.vehicleModel]
      .filter(Boolean)
      .join(" ");

    return (
      <View style={styles.row}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.driverName}>{displayName}</Text>
          {item.user?.username && (
            <Text style={styles.username}>@{item.user.username}</Text>
          )}
          {vehicle ? (
            <View style={styles.vehicleRow}>
              <Ionicons name="car-outline" size={13} color="#94a3b8" />
              <Text style={styles.vehicleText}>
                {vehicle}
                {item.vehiclePlate ? ` · ${item.vehiclePlate}` : ""}
              </Text>
            </View>
          ) : (
            <Text style={styles.noVehicleText}>No vehicle registered</Text>
          )}
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
          <Text style={styles.emptyText}>Failed to load drivers</Text>
          <Pressable style={styles.retryBtn} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : drivers.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="car-outline" size={40} color="#cbd5e1" />
          <Text style={styles.emptyText}>No drivers found</Text>
        </View>
      ) : (
        <FlatList
          data={drivers}
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
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#e0f2fe",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#0284c7" },
  rowInfo: { flex: 1, gap: 2 },
  driverName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  username: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  vehicleRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  vehicleText: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#64748b" },
  noVehicleText: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#cbd5e1", marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
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
