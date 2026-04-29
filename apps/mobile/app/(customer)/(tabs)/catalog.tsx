import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBar } from "@routeflow/ui/mobile/ios";
import { useBuyerProducts, useBuyerCategories, type BuyerProduct } from "../../../lib/api/buyer";
import { useCartStore } from "../../../store/cartStore";

function formatCurrency(n: number | string | null | undefined): string {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

export default function CustomerCatalogScreen() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const { data: categoriesData } = useBuyerCategories();
  const categories = categoriesData ?? [];
  const { data, isLoading } = useBuyerProducts({
    search: search.trim() || undefined,
    category: category || undefined,
    limit: 100,
  });
  const products = data?.data ?? [];
  const cart = useCartStore((s) => s.items);
  const cartCount = cart.reduce((s, i) => s + i.qty, 0);
  const cartTotal = useCartStore((s) => s.total());

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar inlineTitle="Catalog" />

      {/* Search bar */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={16} color={ios.label3} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search products…"
            placeholderTextColor={ios.label3}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {search ? (
            <Pressable onPress={() => setSearch("")} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={ios.label3} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Category pills */}
      {categories.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillsRow}
        >
          {["", ...categories].map((c) => (
            <Pressable
              key={c || "__all__"}
              onPress={() => setCategory(c)}
              style={[styles.pill, category === c && styles.pillActive]}
            >
              <Text style={[styles.pillText, category === c && styles.pillTextActive]}>
                {c || "All"}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: cartCount > 0 ? 100 : 32 }}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : products.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No products found.</Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </View>
        )}
      </ScrollView>

      {/* Floating cart bar */}
      {cartCount > 0 ? (
        <Pressable style={styles.cartBar} onPress={() => router.push("/(customer)/orders/cart")}>
          <View style={styles.cartBadge}>
            <Text style={styles.cartBadgeText}>{cartCount}</Text>
          </View>
          <Text style={styles.cartBarText}>View cart</Text>
          <Text style={styles.cartBarTotal}>{formatCurrency(cartTotal)}</Text>
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

function ProductCard({ product }: { product: BuyerProduct }) {
  const cartItem = useCartStore((s) => s.items.find((i) => i.productId === product.id));
  const add = useCartStore((s) => s.add);
  const setQty = useCartStore((s) => s.setQty);
  const qty = cartItem?.qty ?? 0;

  return (
    <View style={styles.productCard}>
      <View style={styles.productInfo}>
        <Text style={styles.productName} numberOfLines={2}>{product.name}</Text>
        {product.category ? (
          <Text style={styles.productCategory}>{product.category}</Text>
        ) : null}
        <Text style={styles.productPrice}>
          {`$${(Number(product.buyerPrice ?? product.basePrice ?? product.price) || 0).toFixed(2)}`}
          {product.unit ? <Text style={styles.productUnit}> / {product.unit}</Text> : null}
        </Text>
      </View>

      {qty === 0 ? (
        <Pressable
          style={styles.addBtn}
          onPress={() =>
            add({ productId: product.id, name: product.name, unitPrice: Number(product.buyerPrice ?? product.basePrice ?? product.price) || 0, unit: product.unit })
          }
        >
          <Ionicons name="add" size={18} color="#fff" />
        </Pressable>
      ) : (
        <View style={styles.qtyRow}>
          <Pressable
            style={styles.qtyBtn}
            onPress={() => setQty(product.id, qty - 1)}
            hitSlop={4}
          >
            <Ionicons name="remove" size={16} color={ios.brand} />
          </Pressable>
          <Text style={styles.qtyText}>{qty}</Text>
          <Pressable
            style={styles.qtyBtn}
            onPress={() => setQty(product.id, qty + 1)}
            hitSlop={4}
          >
            <Ionicons name="add" size={16} color={ios.brand} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  searchRow: { paddingHorizontal: 16, paddingVertical: 8 },
  searchBox: {
    backgroundColor: ios.fill3,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    gap: 8,
    height: 40,
  },
  searchInput: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  grid: { paddingHorizontal: 16, gap: 8 },
  productCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  productInfo: { flex: 1 },
  productName: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.1 },
  productCategory: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 2 },
  productPrice: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label, marginTop: 6 },
  productUnit: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  addBtn: {
    backgroundColor: ios.brand,
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexShrink: 0,
  },
  qtyBtn: { alignItems: "center", justifyContent: "center" },
  qtyText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label, minWidth: 20, textAlign: "center" },
  pillsRow: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  pill: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ios.separator,
    backgroundColor: ios.bgElev,
    paddingHorizontal: 12,
    paddingVertical: 5,
    minHeight: 28,
    justifyContent: "center",
  },
  pillActive: { backgroundColor: ios.brand, borderColor: ios.brand },
  pillText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  pillTextActive: { color: "#fff" },
  cartBar: {
    position: "absolute",
    bottom: 16,
    left: 16,
    right: 16,
    backgroundColor: ios.brand,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  cartBadge: {
    backgroundColor: "rgba(255,255,255,0.25)",
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  cartBadgeText: { color: "#fff", fontSize: 12, fontFamily: "Inter_700Bold" },
  cartBarText: { flex: 1, color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  cartBarTotal: { color: "#fff", fontSize: 15, fontFamily: "Inter_700Bold", fontVariant: ["tabular-nums"] },
});
