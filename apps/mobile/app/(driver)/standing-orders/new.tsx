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
import { useState } from "react";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useCreateStandingOrder } from "../../../lib/api/standing-orders";
import { useCustomers } from "../../../lib/api/customers";
import { useProducts } from "../../../lib/api/products";

// ─── Day labels ───────────────────────────────────────────────────────────────

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function DayPicker({
  selected,
  onChange,
}: {
  selected: number[];
  onChange: (days: number[]) => void;
}) {
  return (
    <View style={styles.dayRow}>
      {DAY_LABELS.map((label, i) => {
        const active = selected.includes(i);
        return (
          <Pressable
            key={i}
            style={[styles.dayBtn, active && styles.dayBtnActive]}
            onPress={() => {
              if (active) onChange(selected.filter((d) => d !== i));
              else onChange([...selected, i].sort());
            }}
          >
            <Text style={[styles.dayBtnText, active && styles.dayBtnTextActive]}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Customer picker modal ────────────────────────────────────────────────────

function CustomerPickerModal({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (id: string, name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data } = useCustomers(search);
  const customers = data?.data ?? [];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Select Customer</Text>
          <Pressable onPress={onClose}>
            <Ionicons name="close" size={24} color={colors.navy.DEFAULT} />
          </Pressable>
        </View>
        <View style={styles.modalSearch}>
          <Ionicons name="search-outline" size={18} color="#94a3b8" />
          <TextInput
            style={styles.modalSearchInput}
            placeholder="Search customers…"
            placeholderTextColor="#94a3b8"
            value={search}
            onChangeText={setSearch}
            autoFocus
          />
        </View>
        <ScrollView>
          {customers.map((c: any) => (
            <Pressable
              key={c.id}
              style={styles.listRow}
              onPress={() => {
                onSelect(c.id, c.businessName);
                onClose();
                setSearch("");
              }}
            >
              <Text style={styles.listRowName}>{c.businessName}</Text>
              {c.primaryContactName && (
                <Text style={styles.listRowSub}>{c.primaryContactName}</Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Product picker modal ─────────────────────────────────────────────────────

function ProductPickerModal({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (id: string, name: string, unit: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { data } = useProducts(search);
  const products = data?.data ?? [];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Select Product</Text>
          <Pressable onPress={onClose}>
            <Ionicons name="close" size={24} color={colors.navy.DEFAULT} />
          </Pressable>
        </View>
        <View style={styles.modalSearch}>
          <Ionicons name="search-outline" size={18} color="#94a3b8" />
          <TextInput
            style={styles.modalSearchInput}
            placeholder="Search products…"
            placeholderTextColor="#94a3b8"
            value={search}
            onChangeText={setSearch}
            autoFocus
          />
        </View>
        <ScrollView>
          {products.map((p: any) => (
            <Pressable
              key={p.id}
              style={styles.listRow}
              onPress={() => {
                onSelect(p.id, p.name, p.unit);
                onClose();
                setSearch("");
              }}
            >
              <Text style={styles.listRowName}>{p.name}</Text>
              <Text style={styles.listRowSub}>{p.unit}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Cart item type ───────────────────────────────────────────────────────────

interface CartItem {
  productId: string;
  name: string;
  unit: string;
  qty: number;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function NewStandingOrderScreen() {
  const [name, setName] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<CartItem[]>([]);

  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [addingProduct, setAddingProduct] = useState<{ id: string; name: string; unit: string } | null>(null);
  const [addQty, setAddQty] = useState("1");

  const createMutation = useCreateStandingOrder();

  function handleAddProduct(id: string, pName: string, unit: string) {
    setAddingProduct({ id, name: pName, unit });
    setAddQty("1");
  }

  function confirmAddProduct() {
    if (!addingProduct) return;
    const qty = parseFloat(addQty);
    if (!qty || qty <= 0) return Alert.alert("Enter a valid quantity.");
    const existing = items.findIndex((i) => i.productId === addingProduct.id);
    if (existing >= 0) {
      setItems((prev) =>
        prev.map((i, idx) => (idx === existing ? { ...i, qty: i.qty + qty } : i)),
      );
    } else {
      setItems((prev) => [
        ...prev,
        { productId: addingProduct.id, name: addingProduct.name, unit: addingProduct.unit, qty },
      ]);
    }
    setAddingProduct(null);
  }

  function handleCreate() {
    if (!name.trim()) return Alert.alert("Enter a template name.");
    if (!customerId) return Alert.alert("Select a customer.");
    if (daysOfWeek.length === 0) return Alert.alert("Select at least one delivery day.");
    if (items.length === 0) return Alert.alert("Add at least one product.");

    createMutation.mutate(
      {
        customerId,
        name: name.trim(),
        daysOfWeek,
        notes: notes.trim() || undefined,
        items: items.map((i) => ({ productId: i.productId, qty: i.qty })),
      },
      {
        onSuccess: () => {
          Alert.alert("Created", `Standing order "${name}" created.`, [
            { text: "OK", onPress: () => router.back() },
          ]);
        },
        onError: (e) => Alert.alert("Error", e.message ?? "Failed to create."),
      },
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "New Standing Order" }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Template name */}
        <View style={styles.sectionLabel}>
          <Text style={styles.sectionTitle}>Template Name</Text>
        </View>
        <View style={styles.card}>
          <TextInput
            style={styles.nameInput}
            placeholder="e.g. Weekly Bread Order"
            placeholderTextColor="#94a3b8"
            value={name}
            onChangeText={setName}
            returnKeyType="next"
          />
        </View>

        {/* Customer */}
        <View style={styles.sectionLabel}>
          <Text style={styles.sectionTitle}>Customer</Text>
        </View>
        <Pressable style={styles.card} onPress={() => setShowCustomerPicker(true)}>
          <View style={styles.selectRow}>
            <Text style={customerId ? styles.selectValue : styles.selectPlaceholder}>
              {customerId ? customerName : "Select customer…"}
            </Text>
            <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
          </View>
        </Pressable>

        {/* Delivery days */}
        <View style={styles.sectionLabel}>
          <Text style={styles.sectionTitle}>Delivery Days</Text>
        </View>
        <View style={[styles.card, { paddingHorizontal: 16, paddingVertical: 14 }]}>
          <DayPicker selected={daysOfWeek} onChange={setDaysOfWeek} />
        </View>

        {/* Products */}
        <View style={[styles.sectionLabel, { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }]}>
          <Text style={styles.sectionTitle}>Products</Text>
          <Pressable style={styles.addItemBtn} onPress={() => setShowProductPicker(true)}>
            <Ionicons name="add" size={16} color={colors.brand[600]} />
            <Text style={styles.addItemBtnText}>Add</Text>
          </Pressable>
        </View>
        <View style={styles.card}>
          {items.length === 0 ? (
            <Pressable style={styles.emptyItems} onPress={() => setShowProductPicker(true)}>
              <Ionicons name="add-circle-outline" size={24} color="#cbd5e1" />
              <Text style={styles.emptyItemsText}>Tap Add to choose products</Text>
            </Pressable>
          ) : (
            items.map((item, idx) => (
              <View key={item.productId}>
                {idx > 0 && <View style={styles.divider} />}
                <View style={styles.itemRow}>
                  <View style={styles.itemLeft}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.itemUnit}>{item.unit}</Text>
                  </View>
                  <View style={styles.itemRight}>
                    <Pressable
                      style={styles.qtyMiniBtn}
                      onPress={() =>
                        setItems((prev) =>
                          prev.map((i) =>
                            i.productId === item.productId
                              ? { ...i, qty: Math.max(1, i.qty - 1) }
                              : i,
                          ),
                        )
                      }
                    >
                      <Ionicons name="remove" size={16} color={colors.navy.DEFAULT} />
                    </Pressable>
                    <Text style={styles.qtyText}>{item.qty}</Text>
                    <Pressable
                      style={styles.qtyMiniBtn}
                      onPress={() =>
                        setItems((prev) =>
                          prev.map((i) =>
                            i.productId === item.productId ? { ...i, qty: i.qty + 1 } : i,
                          ),
                        )
                      }
                    >
                      <Ionicons name="add" size={16} color={colors.navy.DEFAULT} />
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        setItems((prev) =>
                          prev.filter((i) => i.productId !== item.productId),
                        )
                      }
                      style={styles.removeBtn}
                    >
                      <Ionicons name="trash-outline" size={18} color="#ef4444" />
                    </Pressable>
                  </View>
                </View>
              </View>
            ))
          )}
        </View>

        {/* Notes */}
        <View style={styles.sectionLabel}>
          <Text style={styles.sectionTitle}>Notes (optional)</Text>
        </View>
        <View style={styles.card}>
          <TextInput
            style={styles.notesInput}
            placeholder="Any notes for this template…"
            placeholderTextColor="#94a3b8"
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={3}
          />
        </View>

        {/* Submit */}
        <Pressable
          style={[styles.submitBtn, createMutation.isPending && { opacity: 0.5 }]}
          onPress={handleCreate}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>Create Standing Order</Text>
          )}
        </Pressable>
      </ScrollView>

      <CustomerPickerModal
        visible={showCustomerPicker}
        onClose={() => setShowCustomerPicker(false)}
        onSelect={(id, cName) => {
          setCustomerId(id);
          setCustomerName(cName);
        }}
      />

      <ProductPickerModal
        visible={showProductPicker}
        onClose={() => setShowProductPicker(false)}
        onSelect={handleAddProduct}
      />

      {/* Qty confirmation modal after product selected */}
      <Modal
        visible={!!addingProduct}
        transparent
        animationType="fade"
        onRequestClose={() => setAddingProduct(null)}
      >
        <Pressable style={styles.qtyOverlay} onPress={() => setAddingProduct(null)}>
          <View style={styles.qtySheet}>
            <Text style={styles.qtySheetTitle}>{addingProduct?.name}</Text>
            <Text style={styles.qtySheetSub}>{addingProduct?.unit}</Text>
            <View style={styles.qtyRowCentered}>
              <Pressable
                style={styles.qtyBtn}
                onPress={() => setAddQty((q) => String(Math.max(1, parseFloat(q) - 1)))}
              >
                <Ionicons name="remove" size={22} color={colors.navy.DEFAULT} />
              </Pressable>
              <TextInput
                style={styles.qtyInputLarge}
                value={addQty}
                onChangeText={setAddQty}
                keyboardType="decimal-pad"
                textAlign="center"
              />
              <Pressable
                style={styles.qtyBtn}
                onPress={() => setAddQty((q) => String(parseFloat(q) + 1))}
              >
                <Ionicons name="add" size={22} color={colors.navy.DEFAULT} />
              </Pressable>
            </View>
            <Pressable style={styles.confirmQtyBtn} onPress={confirmAddProduct}>
              <Text style={styles.confirmQtyBtnText}>Add to Template</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  content: { paddingBottom: 48 },

  sectionLabel: {
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 6,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  card: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    borderRadius: borderRadius.lg,
    overflow: "hidden",
    ...shadows.card,
  },
  nameInput: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 52,
  },
  selectRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 52,
  },
  selectValue: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  selectPlaceholder: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },

  dayRow: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  dayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  dayBtnActive: {
    backgroundColor: colors.brand[600],
    borderColor: colors.brand[600],
  },
  dayBtnText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  dayBtnTextActive: { color: "#fff" },

  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.full,
  },
  addItemBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[600],
  },

  emptyItems: {
    alignItems: "center",
    paddingVertical: 28,
    gap: 8,
  },
  emptyItemsText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    marginHorizontal: 16,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  itemLeft: { flex: 1, gap: 2 },
  itemName: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  itemUnit: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  itemRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  qtyMiniBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  qtyText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    minWidth: 28,
    textAlign: "center",
  },
  removeBtn: { padding: 4 },

  notesInput: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 90,
    textAlignVertical: "top",
  },

  submitBtn: {
    backgroundColor: colors.brand[600],
    marginHorizontal: 16,
    marginTop: 28,
    borderRadius: borderRadius.lg,
    paddingVertical: 16,
    alignItems: "center",
  },
  submitBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },

  // Modals
  modalContainer: { flex: 1, backgroundColor: "#fff" },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    paddingTop: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  modalSearch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    margin: 16,
    backgroundColor: colors.surface.raised,
    borderRadius: borderRadius.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  modalSearchInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
  },
  listRow: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    gap: 2,
  },
  listRowName: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  listRowSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },

  // Qty modal
  qtyOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  qtySheet: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    gap: 16,
    alignItems: "center",
  },
  qtySheetTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    textAlign: "center",
  },
  qtySheetSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: -10,
  },
  qtyRowCentered: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  qtyBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  qtyInputLarge: {
    width: 80,
    height: 48,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.surface.border,
    fontSize: 22,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  confirmQtyBtn: {
    backgroundColor: colors.brand[600],
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignSelf: "stretch",
    alignItems: "center",
  },
  confirmQtyBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
});
