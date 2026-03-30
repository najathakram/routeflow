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
import { useCustomers, type CustomerSummary } from "../../../lib/api/customers";
import { useProducts } from "../../../lib/api/products";
import { useCreateInvoice } from "../../../lib/api/invoices";
import { apiClient } from "../../../lib/api-client";
import { BarcodeScanner } from "../../../components/BarcodeScanner";

// ─── Types ────────────────────────────────────────────────────────────────────

interface InvoiceLineItem {
  productId?: string;
  description: string;
  qty: number;
  unitPrice: number;
  regularPrice?: number;
  isSpecialPrice?: boolean;
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
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
          {customers.map((c) => {
            const isSelected = c.id === selectedId;
            return (
              <Pressable
                key={c.id}
                style={[styles.customerRow, isSelected && styles.customerRowSelected]}
                onPress={() => onSelect(c)}
                accessibilityRole="button"
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
                  {c.phone ? <Text style={styles.customerPhone}>{c.phone}</Text> : null}
                </View>
                {isSelected && <Ionicons name="checkmark-circle" size={24} color={colors.brand[500]} />}
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <View style={styles.stepFooter}>
        <Pressable
          style={[styles.continueBtn, !selectedId && styles.continueBtnDisabled]}
          onPress={onContinue}
          disabled={!selectedId}
        >
          <Text style={[styles.continueBtnText, !selectedId && { color: "#94a3b8" }]}>Continue</Text>
          <Ionicons name="arrow-forward" size={20} color={selectedId ? "#fff" : "#94a3b8"} />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Line Items (Step 2) ──────────────────────────────────────────────────────

function LineItemsPicker({
  items,
  onItemsChange,
  customerId,
  onContinue,
}: {
  items: InvoiceLineItem[];
  onItemsChange: (items: InvoiceLineItem[]) => void;
  customerId: string | null;
  onContinue: () => void;
}) {
  const [search, setSearch] = useState("");
  const [scannerVisible, setScannerVisible] = useState(false);
  const [showAvgCost, setShowAvgCost] = useState(false);
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

  const getEffectivePrice = (product: any): number =>
    priceMap[product.id] ?? parseFloat(String(product.pricePerUnit ?? product.price ?? 0));

  const addProduct = (product: any) => {
    const existing = items.find((i) => i.productId === product.id);
    if (existing) {
      onItemsChange(items.map((i) => i.productId === product.id ? { ...i, qty: i.qty + 1 } : i));
    } else {
      const specialPrice = priceMap[product.id];
      const regularPrice = parseFloat(String(product.pricePerUnit ?? product.price ?? 0));
      onItemsChange([
        ...items,
        {
          productId: product.id,
          description: product.name,
          qty: 1,
          unitPrice: specialPrice ?? regularPrice,
          regularPrice: specialPrice !== undefined ? regularPrice : undefined,
          isSpecialPrice: specialPrice !== undefined,
        },
      ]);
    }
  };

  const removeItem = (idx: number) => onItemsChange(items.filter((_, i) => i !== idx));
  const updateQty = (idx: number, qty: number) => {
    if (qty <= 0) removeItem(idx);
    else onItemsChange(items.map((it, i) => i === idx ? { ...it, qty } : it));
  };
  const updatePrice = (idx: number, price: number) =>
    onItemsChange(items.map((it, i) => i === idx ? { ...it, unitPrice: price } : it));

  const handleBarcodeScan = async (code: string) => {
    setScannerVisible(false);
    try {
      const product = await apiClient.get(`/products/barcode/${code}`).then(r => r.data);
      if (product) addProduct(product);
      else Alert.alert("Not found", `No product with barcode ${code}`);
    } catch {
      Alert.alert("Not found", `No product with barcode ${code}`);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Search bar */}
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={18} color="#94a3b8" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search products..."
          placeholderTextColor="#94a3b8"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={18} color="#94a3b8" />
          </Pressable>
        )}
        <Pressable onPress={() => setScannerVisible(true)}>
          <Ionicons name="barcode-outline" size={22} color={colors.brand[500]} />
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
        {/* Product list */}
        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.brand[500]} />
          </View>
        ) : (
          <View style={{ padding: 16, gap: 6 }}>
            {products.slice(0, 30).map((product) => {
              const regularPrice = parseFloat(String(product.pricePerUnit ?? product.price ?? 0));
              const specialPrice = priceMap[product.id];
              const displayPrice = specialPrice ?? regularPrice;
              return (
                <Pressable
                  key={product.id}
                  style={styles.productRow}
                  onPress={() => addProduct(product)}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.productName}>{product.name}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[styles.productMeta, specialPrice !== undefined && { color: colors.brand[500] }]}>
                        {product.unit ?? ""}{"  ·  "}${displayPrice.toFixed(2)}
                      </Text>
                      {specialPrice !== undefined && (
                        <Text style={{ fontSize: 11, color: '#94a3b8', textDecorationLine: 'line-through' }}>
                          ${regularPrice.toFixed(2)}
                        </Text>
                      )}
                      {showAvgCost && product.averageCost != null && (
                        <Text style={{ fontSize: 11, color: '#94a3b8' }}>
                          (avg: ${parseFloat(String(product.averageCost)).toFixed(2)})
                        </Text>
                      )}
                    </View>
                  </View>
                  <Ionicons name="add-circle-outline" size={24} color={colors.brand[500]} />
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Selected items */}
        {items.length > 0 && (
          <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={styles.sectionHeader}>
                Selected Items ({items.length})
              </Text>
              <Pressable
                onPress={() => setShowAvgCost(v => !v)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
              >
                <Ionicons name={showAvgCost ? "eye-off-outline" : "eye-outline"} size={16} color="#64748b" />
                <Text style={{ fontSize: 12, color: '#64748b' }}>
                  {showAvgCost ? 'Hide cost' : 'Show cost'}
                </Text>
              </Pressable>
            </View>
            {items.map((item, idx) => (
              <View key={idx} style={styles.selectedItemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.productName}>{item.description}</Text>
                  {item.isSpecialPrice && item.regularPrice !== undefined && (
                    <Text style={{ fontSize: 11, color: '#94a3b8', textDecorationLine: 'line-through' }}>
                      ${item.regularPrice.toFixed(2)}
                    </Text>
                  )}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <View style={styles.qtyControl}>
                    <Pressable style={styles.qtyBtn} onPress={() => updateQty(idx, item.qty - 1)}>
                      <Ionicons name="remove" size={14} color={colors.navy.DEFAULT} />
                    </Pressable>
                    <Text style={styles.qtyText}>{item.qty}</Text>
                    <Pressable style={styles.qtyBtn} onPress={() => updateQty(idx, item.qty + 1)}>
                      <Ionicons name="add" size={14} color={colors.brand[500]} />
                    </Pressable>
                  </View>
                  <TextInput
                    style={styles.priceInput}
                    value={String(item.unitPrice)}
                    onChangeText={(v) => updatePrice(idx, parseFloat(v) || 0)}
                    keyboardType="decimal-pad"
                  />
                  <Pressable onPress={() => removeItem(idx)}>
                    <Ionicons name="trash-outline" size={16} color="#ef4444" />
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <View style={styles.stepFooter}>
        <Pressable
          style={[styles.continueBtn, items.length === 0 && styles.continueBtnDisabled]}
          onPress={onContinue}
          disabled={items.length === 0}
        >
          <Text style={[styles.continueBtnText, items.length === 0 && { color: '#94a3b8' }]}>
            Review ({items.length} item{items.length !== 1 ? 's' : ''})
          </Text>
          <Ionicons name="arrow-forward" size={20} color={items.length > 0 ? "#fff" : "#94a3b8"} />
        </Pressable>
      </View>

      <Modal visible={scannerVisible} animationType="slide" onRequestClose={() => setScannerVisible(false)}>
        <BarcodeScanner onScanned={handleBarcodeScan} onClose={() => setScannerVisible(false)} />
      </Modal>
    </View>
  );
}

// ─── Review (Step 3) ──────────────────────────────────────────────────────────

function ReviewStep({
  customer,
  items,
  onSubmit,
  isSubmitting,
}: {
  customer: CustomerSummary;
  items: InvoiceLineItem[];
  onSubmit: (notes: string, sendNow: boolean) => void;
  isSubmitting: boolean;
}) {
  const [notes, setNotes] = useState("");
  const TAX_RATE = 0.1;

  const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      {/* Customer */}
      <View style={styles.reviewCard}>
        <Text style={styles.reviewCardTitle}>Bill To</Text>
        <Text style={styles.productName}>{customer.businessName}</Text>
        {customer.phone ? <Text style={styles.customerPhone}>{customer.phone}</Text> : null}
      </View>

      {/* Line items */}
      <View style={styles.reviewCard}>
        <Text style={styles.reviewCardTitle}>Line Items</Text>
        {items.map((item, idx) => (
          <View key={idx} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surface.border }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontFamily: 'Inter_500Medium', color: colors.navy.DEFAULT }}>{item.description}</Text>
              <Text style={{ fontSize: 12, color: '#64748b' }}>
                {item.qty} × ${item.unitPrice.toFixed(2)}
                {item.isSpecialPrice ? ' (special)' : ''}
              </Text>
            </View>
            <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: colors.navy.DEFAULT }}>
              ${(item.qty * item.unitPrice).toFixed(2)}
            </Text>
          </View>
        ))}
      </View>

      {/* Totals */}
      <View style={styles.reviewCard}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
          <Text style={{ fontSize: 14, color: '#64748b' }}>Subtotal</Text>
          <Text style={{ fontSize: 14, color: colors.navy.DEFAULT }}>${subtotal.toFixed(2)}</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
          <Text style={{ fontSize: 14, color: '#64748b' }}>Tax (10%)</Text>
          <Text style={{ fontSize: 14, color: colors.navy.DEFAULT }}>${tax.toFixed(2)}</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderTopWidth: 1, borderTopColor: colors.surface.border, marginTop: 4 }}>
          <Text style={{ fontSize: 16, fontFamily: 'Inter_700Bold', color: colors.navy.DEFAULT }}>Total</Text>
          <Text style={{ fontSize: 16, fontFamily: 'Inter_700Bold', color: colors.navy.DEFAULT }}>${total.toFixed(2)}</Text>
        </View>
      </View>

      {/* Notes */}
      <View style={styles.reviewCard}>
        <Text style={styles.reviewCardTitle}>Notes (optional)</Text>
        <TextInput
          style={styles.notesInput}
          placeholder="Add notes for the customer..."
          placeholderTextColor="#94a3b8"
          value={notes}
          onChangeText={setNotes}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </View>

      {/* Buttons */}
      <Pressable
        style={[styles.submitBtn, isSubmitting && styles.continueBtnDisabled]}
        onPress={() => onSubmit(notes, false)}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.submitBtnText}>Save as Draft</Text>
        )}
      </Pressable>
      <Pressable
        style={[styles.submitBtn, { backgroundColor: colors.brand[600] ?? colors.brand[500] }, isSubmitting && styles.continueBtnDisabled]}
        onPress={() => onSubmit(notes, true)}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Ionicons name="paper-plane-outline" size={20} color="#fff" />
            <Text style={styles.submitBtnText}>Create & Send Invoice</Text>
          </>
        )}
      </Pressable>
    </ScrollView>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function NewDriverInvoiceScreen() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSummary | null>(null);
  const [items, setItems] = useState<InvoiceLineItem[]>([]);

  const { mutate: createInvoice, isPending: isCreating } = useCreateInvoice();

  const TAX_RATE = 0.1;

  const handleSubmit = (notes: string, sendNow: boolean) => {
    if (!selectedCustomer) return;
    const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
    const taxAmount = subtotal * TAX_RATE;

    createInvoice(
      {
        customerId: selectedCustomer.id,
        items: items.map((it) => ({
          productId: it.productId,
          description: it.description,
          qty: it.qty,
          unitPrice: it.unitPrice,
        })),
        notes: notes.trim() || undefined,
        ...(sendNow ? { send: true } : {}),
      },
      {
        onSuccess: (invoice: any) => {
          Alert.alert(
            sendNow ? "Invoice Sent" : "Draft Saved",
            `Invoice ${invoice.invoiceNumber} has been ${sendNow ? "sent" : "saved as draft"}.`,
            [{ text: "OK", onPress: () => router.back() }],
          );
        },
        onError: (err: any) => {
          Alert.alert("Error", err?.response?.data?.message ?? "Failed to create invoice.");
        },
      },
    );
  };

  const stepLabels = ["Select Customer", "Add Items", "Review"];

  return (
    <>
      <Stack.Screen options={{ title: "New Invoice", headerBackTitle: "Back" }} />
      <View style={{ flex: 1, backgroundColor: colors.surface.raised }}>
        {/* Step indicator */}
        <View style={styles.stepIndicator}>
          {[1, 2, 3].map((s, idx) => (
            <View key={s} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={[styles.stepDot, step >= s && styles.stepDotActive]} />
              {idx < 2 && <View style={[styles.stepLine, step > s && styles.stepLineActive]} />}
            </View>
          ))}
          <Text style={styles.stepLabel}>
            Step {step} of 3 — {stepLabels[step - 1]}
          </Text>
        </View>

        {step === 1 && (
          <CustomerPicker
            selectedId={selectedCustomer?.id ?? null}
            onSelect={setSelectedCustomer}
            onContinue={() => setStep(2)}
          />
        )}

        {step === 2 && selectedCustomer && (
          <View style={{ flex: 1 }}>
            <Pressable style={styles.changeCustomerBar} onPress={() => setStep(1)}>
              <Ionicons name="arrow-back" size={16} color={colors.brand[500]} />
              <Text style={styles.changeCustomerText}>
                {selectedCustomer.businessName} — tap to change
              </Text>
            </Pressable>
            <LineItemsPicker
              items={items}
              onItemsChange={setItems}
              customerId={selectedCustomer.id}
              onContinue={() => setStep(3)}
            />
          </View>
        )}

        {step === 3 && selectedCustomer && (
          <View style={{ flex: 1 }}>
            <Pressable style={styles.changeCustomerBar} onPress={() => setStep(2)}>
              <Ionicons name="arrow-back" size={16} color={colors.brand[500]} />
              <Text style={styles.changeCustomerText}>Back to items</Text>
            </Pressable>
            <ReviewStep
              customer={selectedCustomer}
              items={items}
              onSubmit={handleSubmit}
              isSubmitting={isCreating}
            />
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
  stepDotActive: { backgroundColor: colors.brand[500] },
  stepLine: {
    flex: 1,
    height: 2,
    backgroundColor: colors.surface.border,
    maxWidth: 40,
  },
  stepLineActive: { backgroundColor: colors.brand[500] },
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
  continueBtnDisabled: { backgroundColor: colors.surface.border },
  continueBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
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
    marginBottom: 6,
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
  selectedItemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 12,
    marginBottom: 6,
    ...shadows.card,
  },
  qtyControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surface.raised,
    borderWidth: 1,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    minWidth: 20,
    textAlign: "center",
  },
  priceInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    textAlign: "right",
    minWidth: 70,
  },
  sectionHeader: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  reviewCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 4,
    ...shadows.card,
    marginBottom: 4,
  },
  reviewCardTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.lg,
    padding: 10,
    fontSize: 14,
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
    marginBottom: 8,
  },
  submitBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
