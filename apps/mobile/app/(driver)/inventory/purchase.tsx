import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useState } from "react";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useStockOverview, useRecordPurchase } from "../../../lib/api/inventory";

export default function RecordPurchaseScreen() {
  const { data: stock } = useStockOverview();
  const { mutate: recordPurchase, isPending } = useRecordPurchase();

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);

  const selectedProduct = (stock ?? []).find((s) => s.productId === selectedProductId);

  const filtered = (stock ?? []).filter((s) =>
    s.productName.toLowerCase().includes(productSearch.toLowerCase()),
  );

  const isValid =
    !!selectedProductId &&
    !isNaN(parseInt(qty, 10)) &&
    parseInt(qty, 10) > 0 &&
    !isNaN(parseFloat(unitCost)) &&
    parseFloat(unitCost) >= 0;

  const handleSubmit = () => {
    if (!isValid || !selectedProductId) return;
    Keyboard.dismiss();

    recordPurchase(
      {
        productId: selectedProductId,
        quantity: parseInt(qty, 10),
        unitCost: parseFloat(unitCost),
        reference: reference || undefined,
        notes: notes || "Purchase recorded via driver app",
      },
      {
        onSuccess: () => {
          Alert.alert("Done", "Purchase recorded successfully.", [
            { text: "OK", onPress: () => router.back() },
          ]);
        },
        onError: (err) => {
          Alert.alert("Error", "Failed to record purchase.\n" + (err.message || ""));
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: "Record Purchase", headerBackTitle: "Stock" }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={88}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Product picker */}
          <View style={styles.section}>
            <Text style={styles.label}>Product</Text>
            {selectedProduct ? (
              <Pressable
                style={styles.selectedProduct}
                onPress={() => { setSelectedProductId(null); setProductSearch(""); setShowDropdown(true); }}
              >
                <View style={styles.selectedProductLeft}>
                  <Text style={styles.selectedProductName}>{selectedProduct.productName}</Text>
                  <Text style={styles.selectedProductUnit}>{selectedProduct.unit} · Stock: {selectedProduct.currentStock}</Text>
                </View>
                <Ionicons name="close-circle" size={22} color="#94a3b8" />
              </Pressable>
            ) : (
              <View>
                <View style={styles.searchRow}>
                  <Ionicons name="search-outline" size={18} color="#94a3b8" />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search product…"
                    placeholderTextColor="#94a3b8"
                    value={productSearch}
                    onChangeText={(v) => { setProductSearch(v); setShowDropdown(true); }}
                    onFocus={() => setShowDropdown(true)}
                    autoFocus
                  />
                </View>
                {showDropdown && filtered.length > 0 && (
                  <View style={styles.dropdown}>
                    {filtered.slice(0, 8).map((item) => (
                      <Pressable
                        key={item.productId}
                        style={styles.dropdownItem}
                        onPress={() => {
                          setSelectedProductId(item.productId);
                          setProductSearch(item.productName);
                          setShowDropdown(false);
                          Keyboard.dismiss();
                        }}
                      >
                        <Text style={styles.dropdownName}>{item.productName}</Text>
                        <Text style={styles.dropdownMeta}>{item.unit} · {item.currentStock} in stock</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Quantity + unit cost */}
          <View style={styles.section}>
            <View style={styles.twoCol}>
              <View style={styles.colItem}>
                <Text style={styles.label}>Quantity Received</Text>
                <TextInput
                  style={styles.numberInput}
                  placeholder="0"
                  placeholderTextColor="#94a3b8"
                  value={qty}
                  onChangeText={setQty}
                  keyboardType="number-pad"
                  returnKeyType="next"
                />
              </View>
              <View style={styles.colItem}>
                <Text style={styles.label}>Unit Cost ($)</Text>
                <TextInput
                  style={styles.numberInput}
                  placeholder="0.00"
                  placeholderTextColor="#94a3b8"
                  value={unitCost}
                  onChangeText={setUnitCost}
                  keyboardType="decimal-pad"
                  returnKeyType="next"
                />
              </View>
            </View>
            {isValid && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total value</Text>
                <Text style={styles.totalValue}>
                  ${(parseInt(qty, 10) * parseFloat(unitCost)).toFixed(2)}
                </Text>
              </View>
            )}
          </View>

          {/* Reference + notes */}
          <View style={styles.section}>
            <Text style={styles.label}>Reference (optional)</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Invoice / delivery docket number…"
              placeholderTextColor="#94a3b8"
              value={reference}
              onChangeText={setReference}
              returnKeyType="next"
            />
            <Text style={[styles.label, { marginTop: 12 }]}>Notes (optional)</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Supplier name, batch info…"
              placeholderTextColor="#94a3b8"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={2}
              textAlignVertical="top"
            />
          </View>
        </ScrollView>

        {/* Footer */}
        <View style={styles.footer}>
          <Pressable
            style={[styles.submitBtn, (!isValid || isPending) && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={!isValid || isPending}
          >
            {isPending ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <Ionicons name="bag-add-outline" size={22} color="#fff" style={{ marginRight: 8 }} />
            )}
            <Text style={styles.submitBtnText}>
              {isPending ? "Saving…" : "Record Purchase"}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  scroll: {
    padding: 16,
    paddingBottom: 24,
    gap: 12,
  },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  selectedProduct: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.brand[100],
  },
  selectedProductLeft: { flex: 1, gap: 2 },
  selectedProductName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  selectedProductUnit: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.surface.raised,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  dropdown: {
    marginTop: 4,
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.surface.border,
    overflow: "hidden",
  },
  dropdownItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    gap: 2,
  },
  dropdownName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  dropdownMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  twoCol: { flexDirection: "row", gap: 12 },
  colItem: { flex: 1, gap: 8 },
  numberInput: {
    height: 56,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 14,
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.surface.raised,
    textAlign: "center",
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  totalLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  totalValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  textInput: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 68,
    backgroundColor: colors.surface.raised,
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  submitBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
