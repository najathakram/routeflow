import { useState } from "react";
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
import { ios } from "@routeflow/ui/tokens";
import { useAdminProducts, AdminProduct } from "../../../lib/api/admin";
import { useDebounce } from "../../../lib/use-debounce";

export default function AdminProductsScreen() {
  const [search, setSearch] = useState("");
  const [showLowStock, setShowLowStock] = useState(false);
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 300);

  const params = {
    search: debouncedSearch || undefined,
    lowStock: showLowStock || undefined,
    page,
    limit: 30,
  };

  const { data, isLoading, isError, refetch, isFetching } = useAdminProducts(params);
  const products = data?.data ?? [];
  const hasMore = data?.meta ? page * 30 < (data.meta.total ?? 0) : false;

  const isLowStock = (product: AdminProduct) =>
    product.reorderLevel != null && product.currentStock <= product.reorderLevel;

  const renderItem = ({ item }: { item: AdminProduct }) => {
    const low = isLowStock(item);
    return (
      <View style={styles.row}>
        <View style={[styles.stockIndicator, { backgroundColor: low ? "#fee2e2" : "#d1fae5" }]}>
          <Ionicons
            name="cube-outline"
            size={18}
            color={low ? "#dc2626" : "#059669"}
          />
        </View>
        <View style={styles.rowInfo}>
          <View style={styles.rowTopLine}>
            <Text style={styles.productName}>{item.name}</Text>
            {!item.isActive && (
              <View style={styles.inactiveBadge}>
                <Text style={styles.inactiveBadgeText}>Inactive</Text>
              </View>
            )}
          </View>
          {item.barcode ? (
            <Text style={styles.metaText}>Barcode: {item.barcode}</Text>
          ) : item.sku ? (
            <Text style={styles.metaText}>SKU: {item.sku}</Text>
          ) : null}
          <Text style={styles.supplierText}>
            {item.supplier?.name ?? "No supplier"}
          </Text>
        </View>
        <View style={styles.rowRight}>
          <Text style={styles.price}>${Number(item.pricePerUnit).toFixed(2)}</Text>
          <Text style={styles.unit}>per {item.unit}</Text>
          <Text style={[styles.stock, low && styles.stockLow]}>
            {item.currentStock} in stock
          </Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Search */}
      <View style={styles.searchContainer}>
        <Ionicons name="search-outline" size={18} color={ios.label2} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search products..."
          placeholderTextColor={ios.label2}
          value={search}
          onChangeText={(t) => {
            setSearch(t);
            setPage(1);
          }}
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color={ios.label2} />
          </Pressable>
        )}
      </View>

      {/* Low stock toggle */}
      <View style={styles.filterRow}>
        <Pressable
          style={[styles.chip, showLowStock && styles.chipActive]}
          onPress={() => {
            setShowLowStock(!showLowStock);
            setPage(1);
          }}
        >
          <Ionicons
            name="warning-outline"
            size={14}
            color={showLowStock ? "#fff" : "#ea580c"}
          />
          <Text style={[styles.chipText, showLowStock && styles.chipTextActive]}>
            Low Stock Only
          </Text>
        </Pressable>
      </View>

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 48 }} color={ios.brand} />
      ) : isError ? (
        <View style={styles.emptyState}>
          <Ionicons name="cloud-offline-outline" size={40} color={ios.gray[3]} />
          <Text style={styles.emptyText}>Failed to load products</Text>
          <Pressable style={styles.retryBtn} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : products.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="cube-outline" size={40} color={ios.gray[3]} />
          <Text style={styles.emptyText}>No products found</Text>
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={isFetching && page === 1} onRefresh={() => { setPage(1); refetch(); }} />
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
    borderColor: ios.separator,
    height: 44,
  },
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  filterRow: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    flexDirection: "row",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 100,
    backgroundColor: "#fff7ed",
    borderWidth: 1,
    borderColor: "#fed7aa",
  },
  chipActive: { backgroundColor: "#ea580c", borderColor: "#ea580c" },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#ea580c" },
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
  stockIndicator: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  rowInfo: { flex: 1, gap: 2 },
  rowTopLine: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  productName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  inactiveBadge: {
    backgroundColor: "#f1f5f9",
    borderRadius: 100,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  inactiveBadgeText: { fontSize: 10, fontFamily: "Inter_500Medium", color: ios.label2 },
  metaText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  supplierText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  rowRight: { alignItems: "flex-end", gap: 2 },
  price: { fontSize: 14, fontFamily: "Inter_700Bold", color: ios.label },
  unit: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2 },
  stock: { fontSize: 12, fontFamily: "Inter_500Medium", color: "#059669" },
  stockLow: { color: "#dc2626" },
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
