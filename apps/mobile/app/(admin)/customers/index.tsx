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
import { useAdminCustomers, AdminCustomer } from "../../../lib/api/admin";
import { useDebounce } from "../../../lib/use-debounce";

const STATUS_FILTERS = ["ALL", "ACTIVE", "INACTIVE"];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  ACTIVE: { bg: "#d1fae5", text: "#065f46" },
  INACTIVE: { bg: "#f1f5f9", text: "#475569" },
};

export default function AdminCustomersScreen() {
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

  const { data, isLoading, isError, refetch, isFetching } = useAdminCustomers(params);
  const customers = data?.data ?? [];
  const hasMore = data?.meta ? page * 20 < (data.meta.total ?? 0) : false;

  const onRefresh = useCallback(() => {
    setPage(1);
    refetch();
  }, [refetch]);

  const renderItem = ({ item }: { item: AdminCustomer }) => {
    const sc = STATUS_COLORS[item.status] ?? { bg: "#f1f5f9", text: "#475569" };
    return (
      <Pressable
        style={styles.row}
        onPress={() => router.push(`/(admin)/customers/${item.id}` as any)}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {item.businessName.charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.businessName}>{item.businessName}</Text>
          {item.contactName ? (
            <Text style={styles.contactName}>{item.contactName}</Text>
          ) : null}
          {item.phone ? (
            <Text style={styles.phone}>{item.phone}</Text>
          ) : null}
        </View>
        <View style={styles.rowRight}>
          <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.statusText, { color: sc.text }]}>
              {item.status}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Search */}
      <View style={styles.searchContainer}>
        <Ionicons name="search-outline" size={18} color="#94a3b8" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search customers..."
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

      {/* Filter chips */}
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
          <Text style={styles.emptyText}>Failed to load customers</Text>
          <Pressable style={styles.retryBtn} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : customers.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="people-outline" size={40} color="#cbd5e1" />
          <Text style={styles.emptyText}>No customers found</Text>
        </View>
      ) : (
        <FlatList
          data={customers}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={isFetching && page === 1} onRefresh={onRefresh} />
          }
          ListFooterComponent={
            hasMore ? (
              <Pressable style={styles.loadMoreBtn} onPress={() => setPage((p) => p + 1)}>
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
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#dbeafe",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#1e40af",
  },
  rowInfo: { flex: 1, gap: 2 },
  businessName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  contactName: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  phone: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  rowRight: { alignItems: "flex-end", gap: 8 },
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
  loadMoreText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#2563EB",
  },
});
