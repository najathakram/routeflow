import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useBuyerFavorites, useToggleFavorite, type BuyerProduct } from "../../lib/api/buyer";
import { useCartStore } from "../../store/cartStore";

function priceOf(p: BuyerProduct): number {
  return Number(p.buyerPrice ?? p.basePrice ?? p.price) || 0;
}
function idOf(p: BuyerProduct): string {
  return (p as { productId?: string }).productId ?? p.id;
}

/**
 * Favorites-only view — the products the buyer hearted, with quick add-to-cart
 * and un-favorite. Mirrors web's buyer favorites page.
 */
export default function BuyerFavoritesScreen() {
  const router = useRouter();
  const { data: favorites, isLoading } = useBuyerFavorites();
  const toggleFavorite = useToggleFavorite();
  const add = useCartStore((s) => s.add);
  const cartItems = useCartStore((s) => s.items);
  const cartCount = cartItems.reduce(
    (s, i) => s + (Number(i.unitsPerBox ?? 0) > 1 ? (i.boxes ?? 0) : i.qty),
    0,
  );

  const items = favorites ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Favorites"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: cartCount > 0 ? 100 : 32 }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="heart-outline" size={44} color={ios.label3} />
            <Text style={styles.empty}>No favorites yet</Text>
            <Text style={styles.emptySub}>Tap the heart on products you buy often.</Text>
            <Pressable
              style={styles.browseBtn}
              onPress={() => router.push("/(customer)/(tabs)/catalog")}
            >
              <Text style={styles.browseText}>Browse catalog</Text>
            </Pressable>
          </View>
        ) : (
          items.map((p) => {
            const id = idOf(p);
            const price = priceOf(p);
            return (
              <View key={id} style={styles.row}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={2}>
                    {p.name}
                  </Text>
                  <Text style={styles.price}>
                    ${price.toFixed(2)}
                    {p.unit ? ` / ${p.unit}` : ""}
                  </Text>
                </View>
                <Pressable
                  hitSlop={8}
                  style={styles.iconBtn}
                  onPress={() => toggleFavorite.mutate({ productId: id, isFavorite: true })}
                  accessibilityLabel="Remove from favorites"
                >
                  <Ionicons name="heart" size={18} color="#ef4444" />
                </Pressable>
                <Pressable
                  style={styles.addBtn}
                  onPress={() =>
                    add({
                      productId: id,
                      name: p.name,
                      unitPrice: price,
                      unit: p.unit,
                      unitsPerBox: p.unitsPerBox ?? null,
                      category: p.category ?? null,
                    })
                  }
                >
                  <Ionicons name="add" size={18} color="#fff" />
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>

      {cartCount > 0 ? (
        <Pressable style={styles.cartBar} onPress={() => router.push("/(customer)/orders/cart")}>
          <View style={styles.cartBadge}>
            <Text style={styles.cartBadgeText}>{cartCount}</Text>
          </View>
          <Text style={styles.cartBarText}>View cart</Text>
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 48, alignItems: "center", gap: 8 },
  empty: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 4 },
  emptySub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  browseBtn: {
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 8,
  },
  browseText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
  },
  name: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  price: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label, marginTop: 4 },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
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
});
