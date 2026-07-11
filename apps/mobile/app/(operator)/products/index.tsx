import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavAction,
  NavBackButton,
  NavBar,
  Pill,
  ProgressTrack,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import {
  useAdminProductsInfinite,
  type AdminProduct,
  type StockStatusFilter,
} from "../../../lib/api/admin";

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const FILTERS: { id: StockStatusFilter | undefined; label: string }[] = [
  { id: undefined, label: "All" },
  { id: "IN_STOCK", label: "In stock" },
  { id: "LOW", label: "Low" },
  { id: "OUT_OF_STOCK", label: "Out" },
];

export default function ProductsListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<StockStatusFilter | undefined>(undefined);
  const [search, setSearch] = useState("");
  // Infinite pages through the whole catalog — the previous single
  // `limit:100` request cut the list off at 100 rows.
  const { data, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
    useAdminProductsInfinite({
      stockStatus: filter,
      search: search.trim() || undefined,
    });

  // De-dupe by id: offset pagination can re-emit a page-boundary row if the
  // catalog is mutated between page fetches — duplicate keys crash FlatList.
  const products = useMemo(() => {
    const seen = new Set<string>();
    const out: AdminProduct[] = [];
    for (const pg of data?.pages ?? [])
      for (const p of pg.data)
        if (!seen.has(p.id)) {
          seen.add(p.id);
          out.push(p);
        }
    return out;
  }, [data]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Products"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable
              style={styles.navBtn}
              onPress={() => router.push("/(operator)/products/scan")}
              hitSlop={6}
            >
              <Ionicons name="barcode-outline" size={18} color={ios.label} />
            </Pressable>
            <NavAction label="Add" bold onPress={() => router.push("/(operator)/products/new")} />
          </View>
        }
      />

      <SearchBar placeholder="Search name, SKU, barcode…" value={search} onChangeText={setSearch} />

      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) => setFilter(FILTERS.find((f) => f.label === label)?.id)}
      />

      <FlatList
        data={products}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <ProductRow p={item} onPress={() => router.push(`/(operator)/products/${item.id}`)} />
        )}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isFetching && !isLoading && !isFetchingNextPage}
            onRefresh={refetch}
          />
        }
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                {search ? "No products match." : "No products yet."}
              </Text>
              <Pressable
                style={styles.primaryBtn}
                onPress={() => router.push("/(operator)/products/new")}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>Add product</Text>
              </Pressable>
            </View>
          )
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={{ paddingVertical: 16 }}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function ProductRow({ p, onPress }: { p: AdminProduct; onPress: () => void }) {
  const stock = toNumber(p.currentStock);
  const threshold = p.reorderPoint ?? 5;
  const pct = threshold > 0 ? Math.min(100, Math.round((stock / threshold) * 100)) : 100;
  const out = stock <= 0;
  const low = !out && stock <= threshold;
  const fill: "red" | "orange" | "brand" | "green" = out ? "red" : low ? "orange" : "brand";

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.topRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.name} numberOfLines={1}>
            {p.name}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {p.sku ? `SKU ${p.sku}` : p.barcode ? `BC ${p.barcode}` : "No SKU"}
            {p.unit ? ` · ${p.unit}` : ""}
            {" · $"}
            {toNumber(p.pricePerUnit).toFixed(2)}
          </Text>
        </View>
        <Text style={styles.qty}>
          {stock}
          {p.reorderPoint != null ? <Text style={styles.min}> / {p.reorderPoint}</Text> : null}
        </Text>
      </View>
      <View style={styles.progressRow}>
        <View style={{ flex: 1 }}>
          <ProgressTrack percent={pct} height={3} fill={fill} />
        </View>
        {out ? (
          <Pill variant="red" small>
            Out
          </Pill>
        ) : low ? (
          <Pill variant="orange" small>
            Low
          </Pill>
        ) : !p.isActive ? (
          <Pill variant="gray" small>
            Inactive
          </Pill>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  navBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { padding: 40, alignItems: "center", gap: 14 },
  emptyText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  primaryBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  row: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
  },
  topRow: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  qty: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  min: { color: ios.label2, fontFamily: "Inter_400Regular" },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
});
