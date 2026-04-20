import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useRouteRun } from "../../../../../lib/api/routes";
import { useProducts } from "../../../../../lib/api/products";
import { useCreateOrderAsDriver } from "../../../../../lib/api/orders";

interface CartItem {
  productId: string;
  name: string;
  unit: string;
  pricePerUnit: number;
  qty: number;
}

export default function NewOrderAtStopScreen() {
  const { stopId, runId } = useLocalSearchParams<{ stopId: string; runId: string }>();
  const { data: run } = useRouteRun(runId ?? "");
  const stop = run?.stops?.find((s) => s.id === stopId) ?? null;

  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState("");
  const [immediateDelivery, setImmediateDelivery] = useState(true);

  const { data: productsData, isLoading: loadingProducts } = useProducts({ search: search || undefined });
  const products = (productsData?.data ?? productsData ?? []) as any[];

  const { mutate: createOrder, isPending } = useCreateOrderAsDriver();

  const addToCart = (product: any) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.productId === product.id);
      if (existing) {
        return prev.map((i) =>
          i.productId === product.id ? { ...i, qty: i.qty + 1 } : i,
        );
      }
      return [...prev, {
        productId: product.id,
        name: product.name,
        unit: product.unit,
        pricePerUnit: Number(product.pricePerUnit),
        qty: 1,
      }];
    });
  };

  const updateQty = (productId: string, delta: number) => {
    setCart((prev) => {
      const updated = prev.map((i) =>
        i.productId === productId ? { ...i, qty: Math.max(0, i.qty + delta) } : i,
      ).filter((i) => i.qty > 0);
      return updated;
    });
  };

  const cartTotal = cart.reduce((s, i) => s + i.pricePerUnit * i.qty, 0);

  const handleSubmit = () => {
    if (cart.length === 0) {
      Alert.alert("Empty Cart", "Add at least one product.");
      return;
    }
    if (!stop?.customerId) {
      Alert.alert("Error", "Could not determine customer for this stop.");
      return;
    }

    createOrder(
      {
        customerId: stop.customerId,
        items: cart.map((i) => ({ productId: i.productId, qty: i.qty })),
        notes: notes.trim() || undefined,
        routeRunId: runId,
        routeRunStopId: stopId,
        immediateDelivery,
      },
      {
        onSuccess: () => {
          Alert.alert(
            "Order Created",
            immediateDelivery
              ? "Order confirmed and added to this stop's delivery."
              : "Order created as pending — it will appear in the schedule.",
          );
          router.back();
        },
        onError: (err: any) => {
          Alert.alert("Error", err?.response?.data?.message ?? err.message ?? "Failed to create order.");
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: `New Order — ${stop?.customer?.businessName ?? "Customer"}`,
          headerBackTitle: "Stop",
        }}
      />
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {/* Customer */}
          <View style={styles.infoCard}>
            <Ionicons name="business-outline" size={18} color={ios.brand} />
            <Text style={styles.infoText} numberOfLines={1} ellipsizeMode="tail">{stop?.customer?.businessName ?? "Loading…"}</Text>
          </View>

          {/* Delivery mode toggle */}
          <View style={styles.toggleCard}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleLeft}>
                <Text style={styles.toggleTitle}>Deliver Now</Text>
                <Text style={styles.toggleSub}>
                  {immediateDelivery
                    ? "Order confirmed and linked to this stop"
                    : "Order saved as pending — operator will schedule it"}
                </Text>
              </View>
              <Switch
                value={immediateDelivery}
                onValueChange={setImmediateDelivery}
                trackColor={{ true: ios.brand, false: ios.separator }}
              />
            </View>
          </View>

          {/* Product search */}
          <View style={styles.searchBox}>
            <Ionicons name="search-outline" size={18} color={ios.label2} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search products…"
              placeholderTextColor={ios.label2}
              value={search}
              onChangeText={setSearch}
              returnKeyType="search"
            />
          </View>

          {/* Product list */}
          {loadingProducts ? (
            <ActivityIndicator color={ios.brand} style={{ marginTop: 16 }} />
          ) : (
            <View style={styles.productList}>
              {products.map((p: any) => {
                const inCart = cart.find((c) => c.productId === p.id);
                return (
                  <View key={p.id} style={styles.productRow}>
                    <View style={styles.productLeft}>
                      <Text style={styles.productName}>{p.name}</Text>
                      <Text style={styles.productPrice}>
                        ${Number(p.pricePerUnit).toFixed(2)} / {p.unit}
                      </Text>
                    </View>
                    {inCart ? (
                      <View style={styles.qtyControl}>
                        <Pressable
                          style={styles.qtyBtn}
                          onPress={() => updateQty(p.id, -1)}
                          accessibilityLabel={`Remove ${p.name}`}
                        >
                          <Ionicons name="remove" size={18} color={ios.brand} />
                        </Pressable>
                        <Text style={styles.qtyText}>{inCart.qty}</Text>
                        <Pressable
                          style={styles.qtyBtn}
                          onPress={() => updateQty(p.id, 1)}
                          accessibilityLabel={`Add ${p.name}`}
                        >
                          <Ionicons name="add" size={18} color={ios.brand} />
                        </Pressable>
                      </View>
                    ) : (
                      <Pressable
                        style={styles.addBtn}
                        onPress={() => addToCart(p)}
                        accessibilityLabel={`Add ${p.name}`}
                      >
                        <Ionicons name="add-circle-outline" size={22} color={ios.brand} />
                      </Pressable>
                    )}
                  </View>
                );
              })}
              {products.length === 0 && (
                <Text style={styles.noProducts}>No products found.</Text>
              )}
            </View>
          )}

          {/* Cart summary */}
          {cart.length > 0 && (
            <View style={styles.cartCard}>
              <Text style={styles.cartTitle}>Cart ({cart.length} item{cart.length !== 1 ? "s" : ""})</Text>
              {cart.map((item) => (
                <View key={item.productId} style={styles.cartRow}>
                  <Text style={styles.cartName}>{item.name}</Text>
                  <Text style={styles.cartQty}>{item.qty} × ${item.pricePerUnit.toFixed(2)}</Text>
                  <Text style={styles.cartTotal}>${(item.qty * item.pricePerUnit).toFixed(2)}</Text>
                </View>
              ))}
              <View style={styles.cartTotalRow}>
                <Text style={styles.cartTotalLabel}>Estimated Total</Text>
                <Text style={styles.cartTotalValue}>${cartTotal.toFixed(2)}</Text>
              </View>
            </View>
          )}

          {/* Notes */}
          <TextInput
            style={styles.notesInput}
            placeholder="Order notes (optional)…"
            placeholderTextColor={ios.label2}
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={2}
            textAlignVertical="top"
          />
        </ScrollView>

        {/* Submit */}
        <View style={styles.footer}>
          <Pressable
            style={[styles.submitBtn, (isPending || cart.length === 0) && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={isPending || cart.length === 0}
            accessibilityRole="button"
          >
            {isPending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark-circle-outline" size={22} color="#fff" style={{ marginRight: 8 }} />
                <Text style={styles.submitBtnText}>
                  {immediateDelivery ? "Create & Confirm Order" : "Create Pending Order"}
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: ios.bg },
  scroll: { padding: 16, gap: 12, paddingBottom: 24 },
  infoCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.brandWash,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    borderWidth: 1,
    borderColor: ios.brand ?? ios.brand + "33",
  },
  infoText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  toggleCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    ...shadows.card,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  toggleLeft: { flex: 1, gap: 2 },
  toggleTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  toggleSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: ios.separator,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  productList: { gap: 8 },
  productRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...shadows.card,
  },
  productLeft: { flex: 1 },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  productPrice: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  qtyControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  qtyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    minWidth: 24,
    textAlign: "center",
  },
  addBtn: {
    padding: 4,
  },
  noProducts: {
    textAlign: "center",
    color: ios.label2,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    paddingVertical: 16,
  },
  cartCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    gap: 8,
    ...shadows.card,
  },
  cartTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  cartRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cartName: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  cartQty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  cartTotal: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    minWidth: 60,
    textAlign: "right",
  },
  cartTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    paddingTop: 8,
    marginTop: 4,
  },
  cartTotalLabel: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  cartTotalValue: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.brandInk ?? ios.brand,
  },
  notesInput: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: ios.separator,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    minHeight: 64,
  },
  footer: {
    padding: 16,
    paddingBottom: 32,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.brand,
    borderRadius: borderRadius.lg,
    padding: 16,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
