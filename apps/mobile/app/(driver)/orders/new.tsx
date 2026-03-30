import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useCreateOrderAsDriver } from "../../../lib/api/orders";
import { useCustomers, type CustomerSummary } from "../../../lib/api/customers";
import { useProducts } from "../../../lib/api/products";
import { apiClient } from "../../../lib/api-client";
import { BarcodeScanner } from "../../../components/BarcodeScanner";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CartItem {
  productId: string;
  name: string;
  unit: string;
  qty: number;
  unitPrice: number;
}

// ─── Customer Picker (Step 1) ─────────────────────────────────────────────────

function CustomerPicker({
  selectedId,
  onSelect,
  onContinue,
}: {
  selectedId: string | null;
  onSelect: (c: CustomerSummary) => void;
  onContinue: () => void;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useCustomers(search);
  const customers = data?.data ?? [];

  const getInitials = (name: string) =>
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || (name[0]?.toUpperCase() ?? "?");

  return (
    <View style={{ flex: 1 }}>
      {/* Search input */}
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={18} color="#94a3b8" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search customers..."
          placeholderTextColor="#94a3b8"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color="#94a3b8" />
          </Pressable>
        )}
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      ) : customers.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No customers found</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 8 }}>
          {customers.map((c) => {
            const isSelected = c.id === selectedId;
            return (
              <Pressable
                key={c.id}
                style={[styles.customerRow, isSelected && styles.customerRowSelected]}
                onPress={() => onSelect(c)}
                accessibilityRole="button"
                accessibilityLabel={`Select ${c.businessName}`}
              >
                <View style={[styles.customerAvatar, isSelected && styles.customerAvatarSelected]}>
                  <Text style={[styles.customerAvatarText, isSelected && { color: "#fff" }]}>
                    {getInitials(c.businessName)}
                  </Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.customerName, isSelected && { color: colors.brand[500] }]}>
                    {c.businessName}
                  </Text>
                  {c.phone ? (
                    <Text style={styles.customerPhone}>{c.phone}</Text>
                  ) : null}
                </View>
                {isSelected && (
                  <Ionicons name="checkmark-circle" size={24} color={colors.brand[500]} />
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* Continue button */}
      <View style={styles.stepFooter}>
        <Pressable
          style={[styles.continueBtn, !selectedId && styles.continueBtnDisabled]}
          onPress={onContinue}
          disabled={!selectedId}
          accessibilityRole="button"
          accessibilityLabel="Continue to product selection"
        >
          <Text style={[styles.continueBtnText, !selectedId && { color: "#94a3b8" }]}>
            Continue
          </Text>
          <Ionicons
            name="arrow-forward"
            size={20}
            color={selectedId ? "#fff" : "#94a3b8"}
          />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Product Picker (Step 2) ──────────────────────────────────────────────────

function ProductPicker({
  cart,
  onCartChange,
  customerId,
}: {
  cart: CartItem[];
  onCartChange: (cart: CartItem[]) => void;
  customerId: string | null;
}) {
  const [search, setSearch] = useState("");
  const [scannerVisible, setScannerVisible] = useState(false);
  const { data, isLoading } = useProducts({ search: search || undefined });
  const products: any[] = data?.data ?? data ?? [];

  const { data: customerPrices } = useQuery({
    queryKey: ['customer-prices', customerId],
    queryFn: () => apiClient.get(`/customers/${customerId}/prices`).then(r => r.data),
    enabled: !!customerId,
  });
  const priceMap: Record<string, number> = (() => {
    const map: Record<string, number> = {};
    if (customerPrices) for (const cp of customerPrices) map[cp.productId] = parseFloat(cp.specialPrice);
    return map;
  })();

  const getQty = (productId: string) =>
    cart.find((c) => c.productId === productId)?.qty ?? 0;

  const getEffectivePrice = (product: any): number => {
    return priceMap[product.id] ?? product.pricePerUnit ?? product.price ?? 0;
  };

  const increment = (product: any) => {
    const effectivePrice = getEffectivePrice(product);
    const existing = cart.find((c) => c.productId === product.id);
    if (existing) {
      onCartChange(
        cart.map((c) =>
          c.productId === product.id ? { ...c, qty: c.qty + 1 } : c,
        ),
      );
    } else {
      onCartChange([
        ...cart,
        {
          productId: product.id,
          name: product.name,
          unit: product.unit ?? "",
          qty: 1,
          unitPrice: effectivePrice,
        },
      ]);
    }
  };

  const decrement = (productId: string) => {
    const existing = cart.find((c) => c.productId === productId);
    if (!existing) return;
    if (existing.qty <= 1) {
      onCartChange(cart.filter((c) => c.productId !== productId));
    } else {
      onCartChange(
        cart.map((c) =>
          c.productId === productId ? { ...c, qty: c.qty - 1 } : c,
        ),
      );
    }
  };

  const handleBarcodeScan = async (code: string) => {
    setScannerVisible(false);
    try {
      const product = await apiClient.get(`/products/barcode/${code}`).then(r => r.data);
      if (product) {
        increment(product);
      } else {
        Alert.alert("Not found", `No product found with barcode ${code}`);
      }
    } catch {
      Alert.alert("Not found", `No product found with barcode ${code}`);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={18} color="#94a3b8" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search products..."
          placeholderTextColor="#94a3b8"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color="#94a3b8" />
          </Pressable>
        )}
        <Pressable onPress={() => setScannerVisible(true)} accessibilityLabel="Scan barcode">
          <Ionicons name="barcode-outline" size={22} color={colors.brand[500]} />
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      ) : products.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No products found</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 8 }}>
          {products.map((product) => {
            const qty = getQty(product.id);
            const regularPrice = parseFloat(String(product.pricePerUnit ?? product.price ?? 0));
            const specialPrice = priceMap[product.id];
            const displayPrice = specialPrice ?? regularPrice;
            return (
              <View key={product.id} style={styles.productRow}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.productName}>{product.name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={[styles.productMeta, specialPrice !== undefined && { color: colors.brand[500], fontFamily: 'Inter_600SemiBold' }]}>
                      {product.unit ?? ""}
                      {"  ·  "}${displayPrice.toFixed(2)}
                    </Text>
                    {specialPrice !== undefined && (
                      <Text style={{ fontSize: 11, fontFamily: 'Inter_400Regular', color: '#94a3b8', textDecorationLine: 'line-through' }}>
                        ${regularPrice.toFixed(2)}
                      </Text>
                    )}
                  </View>
                </View>
                <View style={styles.qtyControl}>
                  <Pressable
                    style={[styles.qtyBtn, qty === 0 && styles.qtyBtnDisabled]}
                    onPress={() => decrement(product.id)}
                    disabled={qty === 0}
                    accessibilityLabel={`Decrease qty for ${product.name}`}
                  >
                    <Ionicons name="remove" size={16} color={qty === 0 ? "#94a3b8" : colors.navy.DEFAULT} />
                  </Pressable>
                  <Text style={styles.qtyText}>{qty}</Text>
                  <Pressable
                    style={styles.qtyBtn}
                    onPress={() => increment(product)}
                    accessibilityLabel={`Increase qty for ${product.name}`}
                  >
                    <Ionicons name="add" size={16} color={colors.brand[500]} />
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Barcode scanner modal */}
      <Modal visible={scannerVisible} animationType="slide" onRequestClose={() => setScannerVisible(false)}>
        <BarcodeScanner
          onScanned={handleBarcodeScan}
          onClose={() => setScannerVisible(false)}
        />
      </Modal>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function NewOrderScreen() {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSummary | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notes, setNotes] = useState("");

  const { mutate: createOrder, isPending: isCreating } = useCreateOrderAsDriver();

  const totalItems = cart.reduce((n, c) => n + c.qty, 0);

  const handleSubmit = () => {
    if (!selectedCustomer) return;
    if (cart.length === 0) {
      Alert.alert("No items", "Please add at least one product to the order.");
      return;
    }
    createOrder(
      {
        customerId: selectedCustomer.id,
        items: cart.map((c) => ({ productId: c.productId, qty: c.qty })),
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          Alert.alert(
            "Order Created",
            "The order has been saved as pending. Assign it to a route when ready.",
            [{ text: "OK", onPress: () => router.back() }],
          );
        },
        onError: (err: any) => {
          Alert.alert(
            "Error",
            err?.response?.data?.message ?? "Failed to create order. Please try again.",
          );
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "New Order",
          headerBackTitle: "Back",
        }}
      />

      <View style={{ flex: 1, backgroundColor: colors.surface.raised }}>
        {/* Step indicator */}
        <View style={styles.stepIndicator}>
          <View style={[styles.stepDot, step >= 1 && styles.stepDotActive]} />
          <View style={[styles.stepLine, step >= 2 && styles.stepLineActive]} />
          <View style={[styles.stepDot, step >= 2 && styles.stepDotActive]} />
          <Text style={styles.stepLabel}>
            Step {step} of 2 — {step === 1 ? "Select Customer" : "Choose Products"}
          </Text>
        </View>

        {step === 1 ? (
          <CustomerPicker
            selectedId={selectedCustomer?.id ?? null}
            onSelect={setSelectedCustomer}
            onContinue={() => setStep(2)}
          />
        ) : (
          <View style={{ flex: 1 }}>
            {/* Change customer link */}
            <Pressable
              style={styles.changeCustomerBar}
              onPress={() => setStep(1)}
              accessibilityRole="button"
              accessibilityLabel="Change selected customer"
            >
              <Ionicons name="arrow-back" size={16} color={colors.brand[500]} />
              <Text style={styles.changeCustomerText}>
                {selectedCustomer?.businessName ?? "Customer"} — tap to change
              </Text>
            </Pressable>

            <ProductPicker cart={cart} onCartChange={setCart} customerId={selectedCustomer?.id ?? null} />

            {/* Cart summary + notes + submit */}
            <View style={styles.step2Footer}>
              {/* Cart summary */}
              {cart.length > 0 && (
                <View style={styles.cartSummary}>
                  <Ionicons name="cart-outline" size={18} color={colors.brand[500]} />
                  <Text style={styles.cartSummaryText}>
                    {cart.length} product{cart.length !== 1 ? "s" : ""},{" "}
                    {totalItems} item{totalItems !== 1 ? "s" : ""}
                  </Text>
                </View>
              )}

              {/* Notes */}
              <TextInput
                style={styles.notesInput}
                placeholder="Order notes (optional)..."
                placeholderTextColor="#94a3b8"
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={2}
                textAlignVertical="top"
              />

              <Pressable
                style={[styles.submitBtn, (cart.length === 0 || isCreating) && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={cart.length === 0 || isCreating}
                accessibilityRole="button"
                accessibilityLabel="Create order"
              >
                {isCreating ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="checkmark-circle-outline" size={22} color="#fff" />
                    <Text style={styles.submitBtnText}>Create Order</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  stepIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.surface.border,
  },
  stepDotActive: {
    backgroundColor: colors.brand[500],
  },
  stepLine: {
    flex: 1,
    height: 2,
    backgroundColor: colors.surface.border,
    maxWidth: 40,
  },
  stepLineActive: {
    backgroundColor: colors.brand[500],
  },
  stepLabel: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
    marginLeft: 4,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    margin: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.surface.border,
    ...shadows.card,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    padding: 0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 80,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  // Customer rows
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    borderWidth: 1.5,
    borderColor: "transparent",
    ...shadows.card,
  },
  customerRowSelected: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  customerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  customerAvatarSelected: {
    backgroundColor: colors.brand[500],
    borderColor: colors.brand[500],
  },
  customerAvatarText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  customerName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  customerPhone: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  stepFooter: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  continueBtn: {
    height: 54,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  continueBtnDisabled: {
    backgroundColor: colors.surface.border,
  },
  continueBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  // Step 2
  changeCustomerBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.brand[50],
    borderBottomWidth: 1,
    borderBottomColor: colors.brand[100] ?? "#dbeafe",
  },
  changeCustomerText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.brand[500],
  },
  productRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    ...shadows.card,
  },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  productMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  qtyControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  qtyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surface.raised,
    borderWidth: 1,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyBtnDisabled: {
    opacity: 0.4,
  },
  qtyText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    minWidth: 24,
    textAlign: "center",
  },
  step2Footer: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 10,
  },
  cartSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
  },
  cartSummaryText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.lg,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 72,
    backgroundColor: colors.surface.raised,
    textAlignVertical: "top",
  },
  submitBtn: {
    height: 54,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  submitBtnDisabled: {
    backgroundColor: colors.surface.border,
  },
  submitBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
