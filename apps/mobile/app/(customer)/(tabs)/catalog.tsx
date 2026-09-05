import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
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
import {
  useBuyerProductsInfinite,
  useBuyerCategories,
  useBuyerFavorites,
  useToggleFavorite,
  useBuyerExpiringAuthorizations,
  useBuyerPromotions,
  useBuyerStockAlerts,
  useSubscribeStockAlert,
  useUnsubscribeStockAlert,
  useBuyerReplenishment,
  type BuyerProduct,
  type BuyerPromotion,
  type LockedCategory,
  type ReplenishmentEstimate,
} from "../../../lib/api/buyer";
import { useCartStore } from "../../../store/cartStore";
import { priceCart, promoRulesFrom } from "../../../lib/buyer-cart-pricing";
import { QtyTextInput } from "../../../components/QtyStepper";
import type { PromotionRule } from "@routeflow/pricing";
import {
  alertIdSet,
  behaviorLabel,
  bogoTileChip,
  computeTileChip,
  deriveTilePrice,
  stockLabel,
  tileCta,
} from "../../../lib/catalog-tile-logic";

function formatCurrency(n: number | string | null | undefined): string {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

export default function CustomerCatalogScreen() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const { data: categoriesData } = useBuyerCategories();
  const categories = categoriesData ?? [];
  // Infinite pages through the seller's whole catalog — the previous single
  // `limit:100` request cut the list off at 100 rows.
  const { data, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
    useBuyerProductsInfinite({
      search: search.trim() || undefined,
      category: category || undefined,
    });
  // De-dupe by id: offset pagination can re-emit a page-boundary row if the
  // catalog is mutated between page fetches — duplicate keys crash FlatList.
  const products = useMemo(() => {
    const seen = new Set<string>();
    const out: BuyerProduct[] = [];
    for (const pg of data?.pages ?? [])
      for (const p of pg.data)
        if (!seen.has(p.id)) {
          seen.add(p.id);
          out.push(p);
        }
    return out;
  }, [data]);
  const hiddenCategories = data?.pages[0]?.hiddenCategories;
  const cart = useCartStore((s) => s.items);
  // Count selling units: boxes for a boxed line (qty is pieces), else pieces.
  const cartCount = cart.reduce(
    (s, i) => s + (Number(i.unitsPerBox ?? 0) > 1 ? (i.boxes ?? 0) : i.qty),
    0,
  );
  const { data: promotions } = useBuyerPromotions();
  const promoRules = useMemo(() => promoRulesFrom(promotions), [promotions]);
  // Promo-aware total so the floating bar matches the cart screen (and what the
  // server bills) — not the base-price cartStore.total().
  const cartTotal = useMemo(() => priceCart(cart, promoRules).subtotal, [cart, promoRules]);

  const { data: favoritesData } = useBuyerFavorites();
  const favoriteIds = useMemo(
    () => new Set((favoritesData ?? []).map((f: any) => f.productId ?? f.id)),
    [favoritesData],
  );
  const toggleFavorite = useToggleFavorite();

  // Expiry badge on the licenses icon; tap opens the licenses screen.
  const { data: expiring = [] } = useBuyerExpiringAuthorizations();

  // Stock-alert (Notify-me) subscriptions — tile subscribed-state comes from
  // this list (no mobile product-detail screen to derive it from per-product).
  const { data: stockAlerts } = useBuyerStockAlerts();
  const alertIds = useMemo(() => alertIdSet(stockAlerts), [stockAlerts]);
  const subscribeAlert = useSubscribeStockAlert();
  const unsubscribeAlert = useUnsubscribeStockAlert();
  const toggleStockAlert = (productId: string) => {
    if (alertIds.has(productId)) unsubscribeAlert.mutate(productId);
    else subscribeAlert.mutate(productId);
  };

  // Replenishment estimates power the "Running low" chip + behavior meta line.
  const { data: replenishment = [] } = useBuyerReplenishment();
  const estimateByProduct = useMemo(
    () => new Map(replenishment.map((e) => [e.productId, e])),
    [replenishment],
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Catalog"
        trailing={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            {/* F30 / R12 (B200): the first customer-side scan affordance. Until
                the buyer realm got its own resolve rung there was nothing to
                open — the operator ladder's two rungs are
                @Roles(OPERATOR, DRIVER), so every customer-token lookup 403'd.
                A pushed screen, not an in-tab overlay: the camera has to cover
                the tab bar. */}
            <Pressable
              onPress={() => router.push("/(customer)/scan")}
              hitSlop={8}
              style={styles.bellBtn}
              accessibilityLabel="Scan barcode"
            >
              <Ionicons name="barcode-outline" size={22} color={ios.label} />
            </Pressable>
            <Pressable
              onPress={() => router.push("/(customer)/favorites")}
              hitSlop={8}
              style={styles.bellBtn}
              accessibilityLabel="Favorites"
            >
              <Ionicons name="heart-outline" size={22} color={ios.label} />
            </Pressable>
            <Pressable
              onPress={() => router.push("/(customer)/licenses")}
              hitSlop={8}
              style={styles.bellBtn}
              accessibilityLabel="Licenses"
            >
              <Ionicons name="shield-checkmark-outline" size={22} color={ios.label} />
              {expiring.length > 0 ? <View style={styles.bellDot} /> : null}
            </Pressable>
          </View>
        }
      />

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
          style={styles.pillsScroll}
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

      <FlatList
        data={products}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <ProductCard
            product={item}
            isFavorite={favoriteIds.has(item.id)}
            onToggleFavorite={() =>
              toggleFavorite.mutate({
                productId: item.id,
                isFavorite: favoriteIds.has(item.id),
              })
            }
            promoRules={promoRules}
            promotions={promotions}
            estimate={estimateByProduct.get(item.id)}
            isAlertSubscribed={alertIds.has(item.id)}
            onToggleStockAlert={() => toggleStockAlert(item.id)}
          />
        )}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.grid, { paddingBottom: cartCount > 0 ? 100 : 32 }]}
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
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          hiddenCategories && hiddenCategories.length > 0 ? (
            <LockedCategoriesTile categories={hiddenCategories} />
          ) : null
        }
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.empty}>No products found.</Text>
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

const TONE_COLORS: Record<"ok" | "warn" | "danger", string> = {
  ok: "#16A34A",
  warn: "#B45309",
  danger: "#DC2626",
};

function ProductCard({
  product,
  isFavorite,
  onToggleFavorite,
  promoRules,
  promotions,
  estimate,
  isAlertSubscribed,
  onToggleStockAlert,
}: {
  product: BuyerProduct;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  promoRules: PromotionRule[];
  promotions: BuyerPromotion[] | undefined;
  estimate?: ReplenishmentEstimate;
  isAlertSubscribed: boolean;
  onToggleStockAlert: () => void;
}) {
  const cartItem = useCartStore((s) => s.items.find((i) => i.productId === product.id));
  const add = useCartStore((s) => s.add);
  const step = useCartStore((s) => s.step);
  const setUnits = useCartStore((s) => s.setUnits);
  const upb = Number(product.unitsPerBox ?? 0);
  const boxed = upb > 1;
  // Selling units in the cart: boxes for a boxed product, else pieces.
  const units = cartItem ? (boxed ? (cartItem.boxes ?? 0) : cartItem.qty) : 0;

  const priced = deriveTilePrice(product, promoRules, cartItem);
  // A matching BUY_N_GET_M promo always wins the chip slot — it's qty-agnostic
  // (shown even before the buyer has added enough to earn a free unit) and
  // never a fake percent, unlike the Deal/New/Low/Featured chip below it.
  const chip = bogoTileChip(product, promotions) ?? computeTileChip(product, priced, estimate);
  const behavior = behaviorLabel(estimate);
  const stock = stockLabel(product);
  const cta = tileCta(product, units);
  const thumb = product.imageUrls?.[0] ?? product.thumbnailUrl ?? null;

  return (
    <View style={styles.productCard}>
      {thumb ? (
        <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]}>
          <Ionicons name="cube-outline" size={22} color={ios.label3} />
        </View>
      )}
      <View style={styles.productInfo}>
        <View style={styles.productNameRow}>
          <Text style={[styles.productName, { flex: 1 }]} numberOfLines={2}>
            {product.name}
          </Text>
          <Pressable onPress={onToggleFavorite} hitSlop={8} style={styles.heartBtn}>
            <Ionicons
              name={isFavorite ? "heart" : "heart-outline"}
              size={16}
              color={isFavorite ? "#ef4444" : ios.label3}
            />
          </Pressable>
        </View>
        {chip ? (
          <View style={[styles.chip, styles[`chip_${chip.kind}`]]}>
            <Text style={styles.chipText}>{chip.label}</Text>
          </View>
        ) : null}
        {product.category ? <Text style={styles.productCategory}>{product.category}</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Text style={styles.productPrice}>
            {`$${priced.unitPrice.toFixed(2)}`}
            {product.unit ? <Text style={styles.productUnit}> / {product.unit}</Text> : null}
          </Text>
          {priced.originalPrice != null ? (
            <Text style={styles.struckPrice}>{`$${priced.originalPrice.toFixed(2)}`}</Text>
          ) : null}
        </View>
        <Text style={styles.metaLine}>
          {behavior ? `${behavior} · ` : ""}
          <Text style={{ color: TONE_COLORS[stock.tone] }}>{stock.label}</Text>
        </Text>
      </View>

      {cta === "add" ? (
        <Pressable
          style={styles.addBtn}
          onPress={() =>
            add({
              productId: product.id,
              name: product.name,
              unitPrice: Number(product.buyerPrice ?? product.basePrice ?? product.price) || 0,
              unit: product.unit,
              unitsPerBox: product.unitsPerBox ?? null,
              category: product.category ?? null,
            })
          }
        >
          <Ionicons name="add" size={18} color="#fff" />
        </Pressable>
      ) : cta === "notify" ? (
        <Pressable
          style={[styles.notifyBtn, isAlertSubscribed && styles.notifyBtnSubscribed]}
          onPress={onToggleStockAlert}
        >
          <Ionicons
            name={isAlertSubscribed ? "notifications" : "notifications-outline"}
            size={14}
            color={isAlertSubscribed ? ios.brand : "#fff"}
          />
          <Text style={[styles.notifyText, isAlertSubscribed && styles.notifyTextSubscribed]}>
            {isAlertSubscribed ? "Notifying ✓" : "Notify me"}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.qtyRow}>
          <Pressable style={styles.qtyBtn} onPress={() => step(product.id, -1)} hitSlop={4}>
            <Ionicons name="remove" size={16} color={ios.brand} />
          </Pressable>
          <QtyTextInput
            value={units}
            min={1}
            emptyMeansZero={false}
            onChangeQty={(n) => setUnits(product.id, n)}
            style={[styles.qtyText, styles.qtyInputReset]}
          />
          {boxed ? <Text style={styles.qtyText}>{units === 1 ? " box" : " boxes"}</Text> : null}
          <Pressable style={styles.qtyBtn} onPress={() => step(product.id, 1)} hitSlop={4}>
            <Ionicons name="add" size={16} color={ios.brand} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function lockedStatusCopy(status: LockedCategory["status"]): string {
  switch (status) {
    case "PENDING_REVIEW":
      return "pending review";
    case "EXPIRED":
      return "expired — renew to unlock";
    case "REJECTED":
      return "not approved";
    default:
      return "license required";
  }
}

function LockedCategoriesTile({ categories }: { categories: LockedCategory[] }) {
  if (categories.length === 0) return null;
  return (
    <View style={styles.lockedTile}>
      <View style={styles.lockedIcon}>
        <Ionicons name="lock-closed" size={16} color="#B45309" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.lockedTitle}>
          {categories.length === 1 ? "1 category locked" : `${categories.length} categories locked`}
        </Text>
        <Text style={styles.lockedSub}>
          These products unlock once your seller verifies your license.
        </Text>
        <View style={styles.lockedChips}>
          {categories.map((c) => (
            <View key={c.id} style={styles.lockedChip}>
              <Text style={styles.lockedChipText}>
                {c.name} · {lockedStatusCopy(c.status)}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  bellBtn: { padding: 2 },
  bellDot: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#ef4444",
  },
  lockedTile: {
    flexDirection: "row",
    gap: 10,
    // Horizontal inset comes from the FlatList contentContainer padding.
    marginBottom: 8,
    padding: 12,
    borderRadius: 14,
    backgroundColor: "#FEF3C7",
    borderWidth: 1,
    borderColor: "#FCD34D",
  },
  lockedIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#FDE68A",
    alignItems: "center",
    justifyContent: "center",
  },
  lockedTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  lockedSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  lockedChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  lockedChip: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#FCD34D",
    backgroundColor: "#fff",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  lockedChipText: { fontSize: 11, fontFamily: "Inter_500Medium", color: ios.label },
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
  thumb: { width: 56, height: 56, borderRadius: 10, alignSelf: "center", flexShrink: 0 },
  thumbPlaceholder: { backgroundColor: ios.fill3, alignItems: "center", justifyContent: "center" },
  productNameRow: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  heartBtn: { paddingTop: 1 },
  productName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.1,
  },
  productCategory: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 2,
  },
  productPrice: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label, marginTop: 6 },
  productUnit: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  struckPrice: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    textDecorationLine: "line-through",
  },
  metaLine: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 3 },
  chip: {
    alignSelf: "flex-start",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 2,
  },
  chip_deal: { backgroundColor: "#FEE2E2" },
  chip_new: { backgroundColor: "#DBEAFE" },
  chip_low: { backgroundColor: "#FEF3C7" },
  chip_featured: { backgroundColor: "#EDE9FE" },
  chipText: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: ios.label },
  addBtn: {
    backgroundColor: ios.brand,
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  notifyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.brand,
    borderWidth: 1,
    borderColor: ios.brand,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 36,
    flexShrink: 0,
  },
  notifyBtnSubscribed: { backgroundColor: "transparent", borderColor: ios.brand },
  notifyText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#fff" },
  notifyTextSubscribed: { color: ios.brand },
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
  qtyText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    minWidth: 20,
    textAlign: "center",
  },
  qtyInputReset: { paddingVertical: 0, paddingHorizontal: 0 },
  // A horizontal ScrollView's base style is `{ flexGrow: 1, flexShrink: 1 }`, so
  // beside the `flex: 1` product grid it would otherwise both eat the spare space
  // on a short grid and collapse to nothing on a long one. Same guard as
  // FilterChipRow (packages/ui) — see the comment there for the full reasoning.
  pillsScroll: { flexGrow: 0, flexShrink: 0 },
  pillsRow: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: "center" },
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
  cartBarTotal: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
});
