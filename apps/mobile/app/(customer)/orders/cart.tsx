import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useCartStore } from "../../../store/cartStore";
import { useBuyerCreateOrder } from "../../../lib/api/buyer";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function formatDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

export default function CartScreen() {
  const router = useRouter();
  const { items, setQty, remove, clear, total } = useCartStore();
  const createMut = useBuyerCreateOrder();
  const [notes, setNotes] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");

  const onPlaceOrder = () => {
    if (items.length === 0) {
      showToast("Add items from the catalog before placing an order.");
      return;
    }

    createMut.mutate(
      {
        items: items.map((i) => ({ productId: i.productId, qty: i.qty })),
        notes: notes.trim() || undefined,
        requestedDeliveryDate: deliveryDate.trim() || undefined,
      },
      {
        onSuccess: (order) => {
          clear();
          showToast("Order placed");
          router.replace(`/(customer)/orders/${order.id}`);
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Cart"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          items.length > 0 ? (
            <Pressable
              onPress={() =>
                confirm("Clear cart?", "Remove all items?", clear, {
                  confirmText: "Clear",
                  destructive: true,
                })
              }
              hitSlop={8}
            >
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          ) : undefined
        }
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        {items.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="cart-outline" size={48} color={ios.label3} />
            <Text style={styles.emptyText}>Your cart is empty</Text>
            <Pressable
              style={styles.browseBtn}
              onPress={() => router.push("/(customer)/(tabs)/catalog")}
            >
              <Text style={styles.browseBtnText}>Browse catalog</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Items</Text>
              <View style={styles.itemsCard}>
                {items.map((item, i) => (
                  <View
                    key={item.productId}
                    style={[
                      styles.itemRow,
                      i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.itemPrice}>
                        ${item.unitPrice.toFixed(2)}{item.unit ? ` / ${item.unit}` : ""}
                      </Text>
                    </View>
                    <View style={styles.qtyRow}>
                      <Pressable
                        style={styles.qtyBtn}
                        onPress={() => setQty(item.productId, item.qty - 1)}
                        hitSlop={4}
                      >
                        <Ionicons
                          name={item.qty === 1 ? "trash-outline" : "remove"}
                          size={14}
                          color={item.qty === 1 ? ios.system.redInk : ios.brand}
                        />
                      </Pressable>
                      <Text style={styles.qtyText}>{item.qty}</Text>
                      <Pressable
                        style={styles.qtyBtn}
                        onPress={() => setQty(item.productId, item.qty + 1)}
                        hitSlop={4}
                      >
                        <Ionicons name="add" size={14} color={ios.brand} />
                      </Pressable>
                    </View>
                    <Text style={styles.itemTotal}>
                      ${(item.qty * item.unitPrice).toFixed(2)}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Details (optional)</Text>
              <View style={styles.detailCard}>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Delivery date</Text>
                  <TextInput
                    value={deliveryDate}
                    onChangeText={(t) => setDeliveryDate(formatDateInput(t))}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={ios.label3}
                    keyboardType="number-pad"
                    maxLength={10}
                    style={styles.detailInput}
                  />
                </View>
                <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                  <Text style={styles.detailLabel}>Notes</Text>
                  <TextInput
                    value={notes}
                    onChangeText={setNotes}
                    placeholder="Special instructions…"
                    placeholderTextColor={ios.label3}
                    multiline
                    style={[styles.detailInput, { flex: 1, textAlignVertical: "top" }]}
                  />
                </View>
              </View>
            </View>

            {/* Summary */}
            <View style={styles.section}>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>
                  {items.length} item{items.length !== 1 ? "s" : ""}
                </Text>
                <Text style={styles.summaryTotal}>${total().toFixed(2)}</Text>
              </View>
            </View>
          </>
        )}
      </ScrollView>

      {items.length > 0 ? (
        <View style={styles.footer}>
          <Pressable
            style={[styles.placeBtn, createMut.isPending && { opacity: 0.6 }]}
            onPress={onPlaceOrder}
            disabled={createMut.isPending}
          >
            <Text style={styles.placeBtnText}>
              {createMut.isPending ? "Placing order…" : `Place order · $${total().toFixed(2)}`}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  clearText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  empty: { padding: 60, alignItems: "center", gap: 12 },
  emptyText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  browseBtn: {
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 4,
  },
  browseBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  section: { paddingHorizontal: 16, paddingBottom: 16 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 8,
    paddingLeft: 4,
  },
  itemsCard: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemPrice: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  qtyBtn: { width: 20, alignItems: "center", justifyContent: "center" },
  qtyText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label, minWidth: 18, textAlign: "center" },
  itemTotal: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label, fontVariant: ["tabular-nums"], minWidth: 52, textAlign: "right" },
  detailCard: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  detailRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  detailLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, width: 90, paddingTop: 2 },
  detailInput: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, paddingTop: 2 },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  summaryLabel: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label2 },
  summaryTotal: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label, fontVariant: ["tabular-nums"] },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    backgroundColor: ios.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  placeBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  placeBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
