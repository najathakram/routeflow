import { useMemo, useState } from "react";
import {
  Dimensions,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useProducts } from "../../../lib/api/products";
import { ShopSkeleton } from "../../../components/skeletons/ShopSkeleton";
import { NetworkError } from "../../../components/NetworkError";

const SCREEN_WIDTH = Dimensions.get("window").width;
const CARD_WIDTH = (SCREEN_WIDTH - 48) / 2; // 16 padding each side + 16 gap

const ALL = "All";

interface ApiProduct {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  pricePerUnit: string;
  category?: string;
  isActive: boolean;
  lowStock: boolean;
  description?: string;
}

function CategoryPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.pill, active && styles.pillActive]}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function ProductCard({ product }: { product: ApiProduct }) {
  const price = parseFloat(String(product.pricePerUnit));
  return (
    <Pressable
      style={[styles.card, { width: CARD_WIDTH }]}
      onPress={() => router.push(`/(customer)/shop/${product.id}`)}
      accessibilityRole="button"
    >
      {/* Image placeholder */}
      <View style={styles.imagePlaceholder}>
        <Ionicons name="image-outline" size={32} color="#cbd5e1" />
        {product.lowStock ? (
          <View style={styles.lowStockBadge}>
            <Text style={styles.lowStockText}>Low Stock</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.cardBody}>
        <Text style={styles.cardName} numberOfLines={2}>
          {product.name}
        </Text>
        <Text style={styles.cardUnit} numberOfLines={1}>
          {product.unit}
        </Text>
        <View style={styles.cardFooter}>
          <Text style={styles.cardPrice}>${price.toFixed(2)}</Text>
          <Pressable
            style={styles.addButton}
            onPress={() => router.push(`/(customer)/shop/${product.id}`)}
            accessibilityLabel={`Add ${product.name}`}
          >
            <Ionicons name="add" size={18} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

export default function ShopScreen() {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(ALL);

  const { data: result, isLoading, isError, refetch } = useProducts();

  const productList: ApiProduct[] = result?.data ?? [];

  const categories = useMemo(
    () => [ALL, ...Array.from(new Set(productList.map((p) => p.category).filter(Boolean)))],
    [productList],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return productList.filter((p) => {
      const matchesSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.category ?? "").toLowerCase().includes(q);
      const matchesCategory =
        selectedCategory === ALL || p.category === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [search, selectedCategory, productList]);

  if (isLoading) return <><Stack.Screen options={{ title: "Shop" }} /><ShopSkeleton /></>;
  if (isError) return (
    <>
      <Stack.Screen options={{ title: "Shop" }} />
      <NetworkError onRetry={() => refetch()} />
    </>
  );

  return (
    <>
      <Stack.Screen options={{ title: "Shop" }} />
      <View style={styles.container}>
        {/* Search bar */}
        <View style={styles.searchWrapper}>
          <Ionicons
            name="search-outline"
            size={18}
            color="#94a3b8"
            style={styles.searchIcon}
          />
          <TextInput
            style={styles.searchInput}
            placeholder="Search products…"
            placeholderTextColor="#94a3b8"
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>

        {/* Category pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillsContainer}
          style={styles.pillsScroll}
        >
          {categories.map((cat) => (
            <CategoryPill
              key={cat as string}
              label={cat as string}
              active={selectedCategory === cat}
              onPress={() => setSelectedCategory(cat as string)}
            />
          ))}
        </ScrollView>

        {/* Product grid */}
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.grid}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => <ProductCard product={item} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No products found.</Text>
            </View>
          }
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  searchWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.surface.border,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    height: 42,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  pillsScroll: {
    flexGrow: 0,
    marginTop: 8,
  },
  pillsContainer: {
    paddingHorizontal: 16,
    gap: 8,
    paddingVertical: 4,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  pillActive: {
    backgroundColor: colors.brand[500],
    borderColor: colors.brand[500],
  },
  pillText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  pillTextActive: {
    color: "#fff",
  },
  grid: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
  },
  row: {
    gap: 16,
    marginBottom: 16,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    overflow: "hidden",
    ...shadows.card,
  },
  imagePlaceholder: {
    height: 110,
    backgroundColor: "#f1f5f9",
    alignItems: "center",
    justifyContent: "center",
  },
  lowStockBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: colors.warning.bg,
    borderRadius: borderRadius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  lowStockText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: colors.warning.DEFAULT,
  },
  cardBody: {
    padding: 10,
    gap: 2,
  },
  cardName: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    lineHeight: 18,
  },
  cardUnit: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
  },
  cardPrice: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  addButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    alignItems: "center",
    paddingTop: 48,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
