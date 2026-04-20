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
import { ios } from "@routeflow/ui/tokens";
import { useAdminRoutes, AdminRoute } from "../../../lib/api/admin";

const STATUS_FILTERS = ["ALL", "SCHEDULED", "IN_PROGRESS", "COMPLETED"];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  SCHEDULED: { bg: "#dbeafe", text: "#1e40af" },
  IN_PROGRESS: { bg: "#d1fae5", text: "#065f46" },
  COMPLETED: { bg: "#f1f5f9", text: "#475569" },
  ACTIVE: { bg: "#ede9fe", text: "#5b21b6" },
};

export default function AdminRoutesScreen() {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);

  const params = {
    status: statusFilter === "ALL" ? undefined : statusFilter,
    page,
    limit: 20,
  };

  const { data, isLoading, isError, refetch, isFetching } = useAdminRoutes(params);
  const routes = data?.data ?? [];
  const hasMore = data?.meta ? page * 20 < (data.meta.total ?? 0) : false;

  const renderItem = ({ item }: { item: AdminRoute }) => {
    const runStatus = item.activeRun?.status;
    const displayStatus = runStatus ?? item.status ?? "SCHEDULED";
    const sc = STATUS_COLORS[displayStatus] ?? { bg: "#f1f5f9", text: "#475569" };
    const driverName = item.driver?.user
      ? `${item.driver.user.firstName} ${item.driver.user.lastName}`
      : "Unassigned";

    return (
      <View style={styles.row}>
        <View style={[styles.routeIcon, { backgroundColor: "#ede9fe" }]}>
          <Ionicons name="map-outline" size={20} color="#7c3aed" />
        </View>
        <View style={styles.rowInfo}>
          <View style={styles.rowTopLine}>
            <Text style={styles.routeName}>{item.name}</Text>
            {item.activeRun && (
              <View style={styles.liveBadge}>
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>Live</Text>
              </View>
            )}
          </View>
          <View style={styles.infoLine}>
            <Ionicons name="car-outline" size={13} color={ios.label2} />
            <Text style={styles.metaText}>{driverName}</Text>
          </View>
          <View style={styles.infoLine}>
            <Ionicons name="location-outline" size={13} color={ios.label2} />
            <Text style={styles.metaText}>
              {item.stops?.length ?? 0} stops
            </Text>
          </View>
          {item.description ? (
            <Text style={styles.descriptionText} numberOfLines={1}>
              {item.description}
            </Text>
          ) : null}
        </View>
        <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
          <Text style={[styles.statusText, { color: sc.text }]}>
            {displayStatus}
          </Text>
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
        <ActivityIndicator style={{ marginTop: 48 }} color={ios.brand} />
      ) : isError ? (
        <View style={styles.emptyState}>
          <Ionicons name="cloud-offline-outline" size={40} color={ios.gray[3]} />
          <Text style={styles.emptyText}>Failed to load routes</Text>
          <Pressable style={styles.retryBtn} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : routes.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="map-outline" size={40} color={ios.gray[3]} />
          <Text style={styles.emptyText}>No routes found</Text>
        </View>
      ) : (
        <FlatList
          data={routes}
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
                  <ActivityIndicator size="small" color={ios.brand} />
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
    borderColor: ios.separator,
  },
  chipActive: { backgroundColor: ios.brand, borderColor: ios.brand },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
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
  routeIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  rowInfo: { flex: 1, gap: 3 },
  rowTopLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  routeName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#d1fae5",
    borderRadius: 100,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#059669" },
  liveText: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: "#059669" },
  infoLine: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  descriptionText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100, alignSelf: "flex-start" },
  statusText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingBottom: 80,
  },
  emptyText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label2 },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: ios.brand,
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
    borderColor: ios.separator,
  },
  loadMoreText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
