import { useMemo, useState, useEffect } from "react";
import {
  Dimensions,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Platform,
  Alert,
  ToastAndroid,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useProducts, useProductByBarcode } from "../../../lib/api/products";
import { useMyOrders } from "../../../lib/api/orders";
import { ShopSkeleton } from "../../../components/skeletons/ShopSkeleton";
import { NetworkError } from "../../../components/NetworkError";
import { BarcodeScanner } from "../../../components/BarcodeScanner";
import { ProductImage } from "../../../components/ProductImage";
import { useOrderStore } from "../../../store/orderStore";
import { useFavouritesStore } from "../../../store/favouritesStore";

const SCREEN_WIDTH = Dimensions.get("window").width;
const CARD_WIDTH = (SCREEN_WIDTH - 48) / 2;

const ALL = "All";
const FAVOURITES = "Favourites";

interface ApiProduct {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  pricePerUnit: string;
  category?: string;
  isActive: boolean;
  currentStock: number;
  description?: string;
  imageUrl?: string;
}

// ─── Category pill ────────────────────────────────────────────────────────────

function CategoryPill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, active && styles.pillActive]}>
      {label === FAVOURITES ? (
        <Ionicons
          name={active ? "heart" : "heart-outline"}
          size={13}
          color={active ? "#fff" : colors.danger.DEFAULT}
          style={{ marginRight: 4 }}
        />
      ) : null}
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

// ─── Inline quantity stepper ──────────────────────────────────────────────────

function QtyControl({ productId }: { productId: string }) {
  const qty = useOrderStore((s) => s.items.find((i) => i.productId === productId)?.quantity ?? 0);
  const updateQuantity = useOrderStore((s) => s.updateQuantity);
  const removeItem = useOrderStore((s) => s.removeItem);

  if (qty === 0) return null; // handled by the card's add button

  return (
    <View style={styles.stepper}>
      <Pressable
        style={styles.stepBtn}
        onPress={() => (qty === 1 ? removeItem(productId) : updateQuantity(productId, qty - 1))}
        hitSlop={6}
        accessibilityLabel="Decrease quantity"
      >
        <Ionicons name={qty === 1 ? "trash-outline" : "remove"} size={14} color="#fff" />
      </Pressable>
      <Text style={styles.stepQty}>{qty}</Text>
      <Pressable
        style={styles.stepBtn}
        onPress={() => updateQuantity(productId, qty + 1)}
        hitSlop={6}
        accessibilityLabel="Increase quantity"
      >
        <Ionicons name="add" size={14} color="#fff" />
      </Pressable>
    </View>
  );
}

// ─── Product card ─────────────────────────────────────────────────────────────

function ProductCard({ product }: { product: ApiProduct }) {
  const price = parseFloat(String(product.pricePerUnit));
  const stock = Number(product.currentStock ?? 0);
  const isLowStock = stock > 0 && stock <= 5;
  const outOfStock = stock <= 0;

  const toggle = useFavouritesStore((s) => s.toggle);
  const isFav = useFavouritesStore((s) => s.isFavourite(product.id));

  const qty = useOrderStore((s) => s.items.find((i) => i.productId === product.id)?.quantity ?? 0);
  const addItem = useOrderStore((s) => s.addItem);
  const inCart = qty > 0;

  return (
    <View style={[styles.card, { width: CARD_WIDTH }]}>
      {/* Image — tapping navigates to detail */}
      <Pressable
        onPress={() => router.push(`/(customer)/shop/${product.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`View ${product.name} details`}
      >
        <View style={styles.imageContainer}>
          <ProductImage uri={product.imageUrl} size="md" />
          {isLowStock && (
            <View style={styles.lowStockBadge}>
              <Text style={styles.lowStockText}>Low Stock</Text>
            </View>
          )}
          {outOfStock && (
            <View style={styles.outOfStockOverlay}>
              <Text style={styles.outOfStockText}>Out of Stock</Text>
            </View>
          )}
          {/* Heart icon */}
          <Pressable
            onPress={(e) => { e.stopPropagation(); toggle(product.id); }}
            style={styles.heartBtn}
            hitSlop={8}
            accessibilityLabel={isFav ? `Remove ${product.name} from favourites` : `Add ${product.name} to favourites`}
          >
            <Ionicons name={isFav ? "heart" : "heart-outline"} size={16} color={isFav ? colors.danger.DEFAULT : "#fff"} />
          </Pressable>
          {/* In-cart badge */}
          {inCart && (
            <View style={styles.inCartBadge}>
              <Text style={styles.inCartBadgeText}>{qty}</Text>
            </View>
          )}
        </View>
      </Pressable>

      <View style={styles.cardBody}>
        <Pressable onPress={() => router.push(`/(customer)/shop/${product.id}`)}>
          <Text style={styles.cardName} numberOfLines={2}>{product.name}</Text>
          <Text style={styles.cardUnit}>{product.unit}</Text>
        </Pressable>

        <View style={styles.cardFooter}>
          <Text style={styles.cardPrice}>${price.toFixed(2)}</Text>

          {/* Cart control: stepper if in cart, + button if not */}
          {inCart ? (
            <QtyControl productId={product.id} />
          ) : (
            <Pressable
              style={[styles.addButton, outOfStock && styles.addButtonDisabled]}
              onPress={() => {
                if (outOfStock) return;
                addItem(
                  { id: product.id, name: product.name, unit: product.unit, pricePerUnit: product.pricePerUnit },
                  1,
                );
              }}
              disabled={outOfStock}
              accessibilityLabel={`Add ${product.name} to cart`}
            >
              <Ionicons name="add" size={18} color="#fff" />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

// ─── Frequently ordered strip ─────────────────────────────────────────────────

function FrequentlyOrderedStrip({ products }: { products: ApiProduct[] }) {
  const addItem = useOrderStore((s) => s.addItem);
  const items = useOrderStore((s) => s.items);

  if (products.length === 0) return null;

  return (
    <View style={freqStyles.wrapper}>
      <Text style={freqStyles.title}>Buy Again</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={freqStyles.scroll}>
        {products.map((p) => {
          const qty = items.find((i) => i.productId === p.id)?.quantity ?? 0;
          return (
            <Pressable
              key={p.id}
              style={freqStyles.chip}
              onPress={() => router.push(`/(customer)/shop/${p.id}`)}
              accessibilityRole="button"
            >
              <Text style={freqStyles.chipText} numberOfLines={1}>{p.name}</Text>
              {qty > 0 ? (
                <View style={freqStyles.chipBadge}>
                  <Text style={freqStyles.chipBadgeText}>{qty}</Text>
                </View>
              ) : (
                <Pressable
                  style={freqStyles.chipAdd}
                  onPress={(e) => {
                    e.stopPropagation();
                    addItem({ id: p.id, name: p.name, unit: p.unit, pricePerUnit: p.pricePerUnit }, 1);
                  }}
                  hitSlop={4}
                >
                  <Ionicons name="add" size={13} color="#fff" />
                </Pressable>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ─── Floating cart bar ────────────────────────────────────────────────────────

function CartBar() {
  const items = useOrderStore((s) => s.items);
  const totalItems = items.reduce((s, i) => s + i.quantity, 0);
  const totalPrice = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

  if (totalItems === 0) return null;

  return (
    <Pressable
      style={cartStyles.bar}
      onPress={() => router.push("/(customer)/order")}
      accessibilityRole="button"
      accessibilityLabel={`View cart: ${totalItems} items, $${totalPrice.toFixed(2)}`}
    >
      <View style={cartStyles.badge}>
        <Text style={cartStyles.badgeText}>{totalItems}</Text>
      </View>
      <Text style={cartStyles.label}>View Cart</Text>
      <Text style={cartStyles.price}>${totalPrice.toFixed(2)}</Text>
      <Ionicons name="chevron-forward" size={16} color="#fff" />
    </Pressable>
  );
}

const cartStyles = StyleSheet.create({
  bar: {
    position: "absolute",
    bottom: 16,
    left: 16,
    right: 16,
    backgroundColor: colors.brand[600] ?? colors.brand[500],
    borderRadius: borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 10,
    ...shadows.card,
    shadowColor: colors.brand[500],
    shadowOpacity: 0.4,
    elevation: 8,
  },
  badge: {
    backgroundColor: "#fff",
    borderRadius: 10,
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: colors.brand[600] ?? colors.brand[500],
  },
  label: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  price: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function ShopScreen() {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(ALL);
  const [showScanner, setShowScanner] = useState(false);
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);

  const { data: result, isLoading, isError, refetch } = useProducts();
  const { data: barcodeProduct, isError: barcodeError } = useProductByBarcode(pendingBarcode);
  const { data: ordersData } = useMyOrders({ status: "DELIVERED", limit: 10 });
  const favourites = useFavouritesStore((s) => s.favourites);

  const productList: ApiProduct[] = result?.data ?? [];

  useEffect(() => {
    if (barcodeProduct) {
      setPendingBarcode(null);
      router.push(`/(customer)/shop/${barcodeProduct.id}`);
    }
  }, [barcodeProduct]);

  useEffect(() => {
    if (barcodeError && pendingBarcode) {
      setPendingBarcode(null);
      const msg = "No product found for this barcode.";
      if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.SHORT);
      else Alert.alert("Not Found", msg);
    }
  }, [barcodeError, pendingBarcode]);

  const frequentlyOrdered = useMemo<ApiProduct[]>(() => {
    const orders = ordersData?.data ?? [];
    if (orders.length === 0) return [];
    const counts: Record<string, number> = {};
    for (const order of orders) {
      for (const item of order.lineItems ?? []) {
        counts[item.productId] = (counts[item.productId] ?? 0) + item.qty;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => productList.find((p) => p.id === id))
      .filter((p): p is ApiProduct => !!p);
  }, [ordersData, productList]);

  const categories = useMemo(
    () => [FAVOURITES, ALL, ...Array.from(new Set(productList.map((p) => p.category).filter(Boolean)))],
    [productList],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return productList.filter((p) => {
      const matchesSearch = !q || p.name.toLowerCase().includes(q) || (p.category ?? "").toLowerCase().includes(q);
      const matchesCategory =
        selectedCategory === ALL ||
        (selectedCategory === FAVOURITES ? favourites.includes(p.id) : p.category === selectedCategory);
      return matchesSearch && matchesCategory;
    });
  }, [search, selectedCategory, productList, favourites]);

  if (isLoading) return <><Stack.Screen options={{ title: "Shop" }} /><ShopSkeleton /></>;
  if (isError) return <><Stack.Screen options={{ title: "Shop" }} /><NetworkError onRetry={() => refetch()} /></>;

  return (
    <>
      <Stack.Screen options={{ title: "Shop" }} />
      <View style={styles.container}>
        {/* Search bar */}
        <View style={styles.searchWrapper}>
          <Ionicons name="search-outline" size={18} color="#94a3b8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search products…"
            placeholderTextColor="#94a3b8"
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          <Pressable onPress={() => setShowScanner(true)} style={styles.scanButton} accessibilityLabel="Scan barcode">
            <Ionicons name="barcode-outline" size={22} color={colors.brand[500]} />
          </Pressable>
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
          ListHeaderComponent={
            selectedCategory === ALL && !search ? (
              <FrequentlyOrderedStrip products={frequentlyOrdered} />
            ) : null
          }
          renderItem={({ item }) => <ProductCard product={item} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No products found.</Text>
            </View>
          }
        />

        {/* Floating cart bar */}
        <CartBar />
      </View>

      {showScanner && (
        <BarcodeScanner
          onScanned={(code) => { setShowScanner(false); setPendingBarcode(code); }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const freqStyles = StyleSheet.create({
  wrapper: { paddingTop: 8, paddingBottom: 4 },
  title: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  scroll: { paddingHorizontal: 16, gap: 8, paddingVertical: 2 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.brand[200] ?? colors.brand[500] + "44",
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 6,
    maxWidth: 180,
    ...shadows.card,
  },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: colors.navy.DEFAULT, flex: 1 },
  chipAdd: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.brand[500],
    alignItems: "center", justifyContent: "center",
  },
  chipBadge: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.brand[100] ?? "#dbeafe",
    alignItems: "center", justifyContent: "center",
  },
  chipBadgeText: { fontSize: 11, fontFamily: "Inter_700Bold", color: colors.brand[700] ?? colors.brand[500] },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
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
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1, height: 42,
    fontSize: 15, fontFamily: "Inter_400Regular", color: colors.navy.DEFAULT,
  },
  scanButton: { padding: 6, marginLeft: 4 },
  pillsScroll: { flexGrow: 0, marginTop: 8 },
  pillsContainer: { paddingHorizontal: 16, gap: 8, paddingVertical: 4 },
  pill: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: "#fff", borderWidth: 1, borderColor: colors.surface.border,
  },
  pillActive: { backgroundColor: colors.brand[500], borderColor: colors.brand[500] },
  pillText: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#64748b" },
  pillTextActive: { color: "#fff" },
  grid: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 88 /* room for cart bar */ },
  row: { gap: 16, marginBottom: 16 },

  // Card
  card: { backgroundColor: "#fff", borderRadius: borderRadius.lg, overflow: "hidden", ...shadows.card },
  imageContainer: { height: 110, position: "relative", overflow: "hidden" },
  lowStockBadge: {
    position: "absolute", top: 8, left: 8,
    backgroundColor: colors.warning.bg,
    borderRadius: borderRadius.sm, paddingHorizontal: 6, paddingVertical: 2,
  },
  lowStockText: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: colors.warning.DEFAULT },
  outOfStockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center", justifyContent: "center",
  },
  outOfStockText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#fff" },
  heartBtn: {
    position: "absolute", top: 6, right: 6,
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: "rgba(0,0,0,0.25)",
    alignItems: "center", justifyContent: "center",
  },
  inCartBadge: {
    position: "absolute", top: 6, left: 6,
    minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.brand[500],
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 4,
  },
  inCartBadgeText: { fontSize: 11, fontFamily: "Inter_700Bold", color: "#fff" },
  cardBody: { padding: 10, gap: 2 },
  cardName: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: colors.navy.DEFAULT, lineHeight: 18 },
  cardUnit: { fontSize: 11, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  cardFooter: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between", marginTop: 6,
  },
  cardPrice: { fontSize: 15, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  addButton: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: colors.brand[500],
    alignItems: "center", justifyContent: "center",
  },
  addButtonDisabled: { backgroundColor: "#cbd5e1" },

  // Inline stepper
  stepper: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.full,
    overflow: "hidden",
    height: 30,
  },
  stepBtn: {
    width: 28, height: 30,
    alignItems: "center", justifyContent: "center",
  },
  stepQty: {
    fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff",
    minWidth: 20, textAlign: "center",
  },

  empty: { alignItems: "center", paddingTop: 48 },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#94a3b8" },
});
