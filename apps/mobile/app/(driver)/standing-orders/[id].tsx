import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useMyStandingOrder,
  useUpdateStandingOrder,
  useGenerateOrder,
  useAddTemplateItem,
  useRemoveTemplateItem,
  type StandingOrder,
  type TemplateItem,
} from "../../../lib/api/standing-orders";
import { useProducts } from "../../../lib/api/products";
import { NetworkError } from "../../../components/NetworkError";
import { apiClient } from "../../../lib/api-client";

// ─── Day labels ───────────────────────────────────────────────────────────────

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Day picker ───────────────────────────────────────────────────────────────

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
              if (active) {
                onChange(selected.filter((d) => d !== i));
              } else {
                onChange([...selected, i].sort());
              }
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

// ─── Product picker modal ─────────────────────────────────────────────────────

function ProductPickerModal({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (productId: string, name: string, unit: string) => void;
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
              style={styles.productRow}
              onPress={() => {
                onSelect(p.id, p.name, p.unit);
                onClose();
                setSearch("");
              }}
            >
              <Text style={styles.productRowName}>{p.name}</Text>
              <Text style={styles.productRowUnit}>{p.unit}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Add item sheet ───────────────────────────────────────────────────────────

function AddItemSheet({
  visible,
  templateId,
  onClose,
}: {
  visible: boolean;
  templateId: string;
  onClose: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [productId, setProductId] = useState("");
  const [productName, setProductName] = useState("");
  const [unit, setUnit] = useState("");
  const [qty, setQty] = useState("1");
  const addItem = useAddTemplateItem();

  function reset() {
    setProductId("");
    setProductName("");
    setUnit("");
    setQty("1");
  }

  function handleAdd() {
    const qtyNum = parseFloat(qty);
    if (!productId) return Alert.alert("Select a product first.");
    if (!qtyNum || qtyNum <= 0) return Alert.alert("Enter a valid quantity.");

    addItem.mutate(
      { templateId, productId, qty: qtyNum },
      {
        onSuccess: () => {
          reset();
          onClose();
        },
        onError: (e) => Alert.alert("Error", e.message ?? "Failed to add item."),
      },
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetOverlay} onPress={onClose}>
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Add Product</Text>

          <Pressable
            style={styles.productSelectBtn}
            onPress={() => setShowPicker(true)}
          >
            <Text style={productId ? styles.productSelectText : styles.productSelectPlaceholder}>
              {productId ? `${productName} (${unit})` : "Choose product…"}
            </Text>
            <Ionicons name="chevron-down" size={18} color="#94a3b8" />
          </Pressable>

          <View style={styles.qtyRow}>
            <Text style={styles.qtyLabel}>Quantity</Text>
            <Pressable
              style={styles.qtyBtn}
              onPress={() => setQty((q) => String(Math.max(1, parseFloat(q) - 1)))}
            >
              <Ionicons name="remove" size={20} color={colors.navy.DEFAULT} />
            </Pressable>
            <TextInput
              style={styles.qtyInput}
              value={qty}
              onChangeText={setQty}
              keyboardType="decimal-pad"
              textAlign="center"
            />
            <Pressable
              style={styles.qtyBtn}
              onPress={() => setQty((q) => String(parseFloat(q) + 1))}
            >
              <Ionicons name="add" size={20} color={colors.navy.DEFAULT} />
            </Pressable>
          </View>

          <Pressable
            style={[styles.addBtn, (!productId || addItem.isPending) && { opacity: 0.5 }]}
            onPress={handleAdd}
            disabled={!productId || addItem.isPending}
          >
            {addItem.isPending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.addBtnText}>Add to Template</Text>
            )}
          </Pressable>
        </View>
      </Pressable>

      <ProductPickerModal
        visible={showPicker}
        onClose={() => setShowPicker(false)}
        onSelect={(id, name, u) => {
          setProductId(id);
          setProductName(name);
          setUnit(u);
        }}
      />
    </Modal>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function StandingOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: template, isLoading, isError, refetch } = useMyStandingOrder(id);
  const updateMutation = useUpdateStandingOrder();
  const removeItemMutation = useRemoveTemplateItem();
  const generateMutation = useGenerateOrder();

  const [editingDays, setEditingDays] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [showAddItem, setShowAddItem] = useState(false);

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Standing Order" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !template) {
    return (
      <>
        <Stack.Screen options={{ title: "Standing Order" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const todayDay = new Date().getDay();
  const isDueToday = template.isActive && template.daysOfWeek.includes(todayDay);

  function handleToggleActive() {
    updateMutation.mutate(
      { id: template!.id, dto: { isActive: !template!.isActive } },
      { onError: (e) => Alert.alert("Error", e.message) },
    );
  }

  function saveDays() {
    updateMutation.mutate(
      { id: template!.id, dto: { daysOfWeek: selectedDays } },
      {
        onSuccess: () => setEditingDays(false),
        onError: (e) => Alert.alert("Error", e.message),
      },
    );
  }

  function handleRemoveItem(item: TemplateItem) {
    Alert.alert(
      "Remove Product",
      `Remove "${item.product?.name}" from this template?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            removeItemMutation.mutate(
              { templateId: template!.id, itemId: item.id },
              { onError: (e) => Alert.alert("Error", e.message) },
            ),
        },
      ],
    );
  }

  function handleGenerate() {
    Alert.alert(
      "Generate Order Now",
      `Create an order from "${template!.name}" for today?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: () =>
            generateMutation.mutate(template!.id, {
              onSuccess: () =>
                Alert.alert("Order Created", "Order has been generated.", [
                  { text: "OK", onPress: () => router.back() },
                ]),
              onError: (e) =>
                Alert.alert("Error", e.message ?? "Failed to generate order."),
            }),
        },
      ],
    );
  }

  function handleSkip() {
    Alert.alert(
      "Skip Today",
      "Skip this standing order for today? No order will be generated.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Skip", style: "destructive", onPress: () => router.back() },
      ],
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: template.name }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Status banner */}
        {isDueToday && (
          <View style={styles.dueBanner}>
            <Ionicons name="today-outline" size={16} color={colors.brand[600]} />
            <Text style={styles.dueBannerText}>This template is due today</Text>
          </View>
        )}

        {/* Template info card */}
        <View style={styles.card}>
          <View style={styles.cardRow}>
            <Text style={styles.cardLabel}>Status</Text>
            <View style={styles.rowRight}>
              <Text
                style={[
                  styles.statusText,
                  { color: template.isActive ? colors.success.DEFAULT : "#94a3b8" },
                ]}
              >
                {template.isActive ? "Active" : "Inactive"}
              </Text>
              <Switch
                value={template.isActive}
                onValueChange={handleToggleActive}
                trackColor={{ false: "#e2e8f0", true: colors.brand[100] }}
                thumbColor={template.isActive ? colors.brand[600] : "#fff"}
                disabled={updateMutation.isPending}
              />
            </View>
          </View>

          <View style={styles.divider} />

          {template.customer && (
            <>
              <View style={styles.cardRow}>
                <Text style={styles.cardLabel}>Customer</Text>
                <Text style={styles.cardValue}>{template.customer.businessName}</Text>
              </View>
              <View style={styles.divider} />
            </>
          )}

          {/* Delivery days */}
          <View style={styles.cardRow}>
            <Text style={styles.cardLabel}>Delivery Days</Text>
            {!editingDays && (
              <Pressable
                onPress={() => {
                  setSelectedDays([...template.daysOfWeek]);
                  setEditingDays(true);
                }}
                style={styles.editDaysBtn}
              >
                <Text style={styles.editDaysText}>
                  {template.daysOfWeek.length > 0
                    ? template.daysOfWeek.map((d) => DAY_LABELS[d]).join(", ")
                    : "None"}
                </Text>
                <Ionicons name="pencil-outline" size={14} color={colors.brand[600]} />
              </Pressable>
            )}
          </View>

          {editingDays && (
            <View style={styles.dayEditSection}>
              <DayPicker selected={selectedDays} onChange={setSelectedDays} />
              <View style={styles.dayEditActions}>
                <Pressable
                  style={styles.cancelDaysBtn}
                  onPress={() => setEditingDays(false)}
                >
                  <Text style={styles.cancelDaysBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[styles.saveDaysBtn, updateMutation.isPending && { opacity: 0.5 }]}
                  onPress={saveDays}
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.saveDaysBtnText}>Save Days</Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}

          {template.notes && (
            <>
              <View style={styles.divider} />
              <View style={styles.cardRow}>
                <Text style={styles.cardLabel}>Notes</Text>
                <Text style={styles.cardValue}>{template.notes}</Text>
              </View>
            </>
          )}
        </View>

        {/* Products section */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Products</Text>
          <Pressable
            style={styles.addItemBtn}
            onPress={() => setShowAddItem(true)}
          >
            <Ionicons name="add" size={16} color={colors.brand[600]} />
            <Text style={styles.addItemBtnText}>Add</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          {template.items.length === 0 ? (
            <View style={styles.emptyItems}>
              <Text style={styles.emptyItemsText}>No products. Tap Add to get started.</Text>
            </View>
          ) : (
            template.items.map((item, idx) => (
              <View key={item.id}>
                {idx > 0 && <View style={styles.divider} />}
                <View style={styles.itemRow}>
                  <View style={styles.itemLeft}>
                    <Text style={styles.itemName}>{item.product?.name ?? "Unknown"}</Text>
                    <Text style={styles.itemUnit}>{item.product?.unit}</Text>
                  </View>
                  <View style={styles.itemRight}>
                    <View style={styles.qtyBadge}>
                      <Text style={styles.qtyBadgeText}>×{item.qty}</Text>
                    </View>
                    <Pressable
                      onPress={() => handleRemoveItem(item)}
                      style={styles.removeBtn}
                      disabled={removeItemMutation.isPending}
                    >
                      <Ionicons name="trash-outline" size={18} color={colors.danger?.DEFAULT ?? "#ef4444"} />
                    </Pressable>
                  </View>
                </View>
              </View>
            ))
          )}
        </View>

        {/* Actions */}
        {isDueToday && (
          <View style={styles.actionGroup}>
            <Pressable
              style={[styles.confirmBtn, generateMutation.isPending && { opacity: 0.5 }]}
              onPress={handleGenerate}
              disabled={generateMutation.isPending}
            >
              {generateMutation.isPending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
                  <Text style={styles.confirmBtnText}>Confirm Order for Today</Text>
                </>
              )}
            </Pressable>

            <Pressable style={styles.skipBtn} onPress={handleSkip}>
              <Ionicons name="close-circle-outline" size={20} color="#ef4444" />
              <Text style={styles.skipBtnText}>Skip Today</Text>
            </Pressable>
          </View>
        )}

        {!isDueToday && template.isActive && (
          <Pressable
            style={[styles.generateManualBtn, generateMutation.isPending && { opacity: 0.5 }]}
            onPress={handleGenerate}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending ? (
              <ActivityIndicator color={colors.brand[600]} />
            ) : (
              <>
                <Ionicons name="play-outline" size={18} color={colors.brand[600]} />
                <Text style={styles.generateManualBtnText}>Generate Order Now</Text>
              </>
            )}
          </Pressable>
        )}
      </ScrollView>

      <AddItemSheet
        visible={showAddItem}
        templateId={id}
        onClose={() => setShowAddItem(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  content: { paddingBottom: 48, gap: 0 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },

  dueBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 16,
    marginBottom: 0,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  dueBannerText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[600],
  },

  card: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: borderRadius.lg,
    overflow: "hidden",
    ...shadows.card,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 52,
  },
  cardLabel: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  cardValue: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
    flex: 1,
    textAlign: "right",
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    marginHorizontal: 16,
  },

  editDaysBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  editDaysText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.brand[600],
    maxWidth: 200,
  },
  dayEditSection: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    gap: 12,
  },
  dayRow: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  dayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface.raised,
    borderWidth: 1,
    borderColor: colors.surface.border,
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
  dayBtnTextActive: {
    color: "#fff",
  },
  dayEditActions: {
    flexDirection: "row",
    gap: 8,
  },
  cancelDaysBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: borderRadius.DEFAULT,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
  },
  cancelDaysBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  saveDaysBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: borderRadius.DEFAULT,
    backgroundColor: colors.brand[600],
    alignItems: "center",
  },
  saveDaysBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 16,
    marginTop: 24,
    marginBottom: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
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
    padding: 24,
    alignItems: "center",
  },
  emptyItemsText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
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
    gap: 12,
  },
  qtyBadge: {
    backgroundColor: colors.brand[50],
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  qtyBadgeText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[600],
  },
  removeBtn: {
    padding: 4,
  },

  actionGroup: {
    marginHorizontal: 16,
    marginTop: 24,
    gap: 10,
  },
  confirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brand[600],
    borderRadius: borderRadius.lg,
    paddingVertical: 16,
  },
  confirmBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  skipBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  skipBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#ef4444",
  },

  generateManualBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 24,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: colors.brand[100],
  },
  generateManualBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[600],
  },

  // Add item sheet
  sheetOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
    gap: 16,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: colors.surface.border,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  productSelectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface.raised,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  productSelectText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  productSelectPlaceholder: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  qtyLabel: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    flex: 1,
  },
  qtyBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  qtyInput: {
    width: 60,
    height: 40,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.surface.border,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },
  addBtn: {
    backgroundColor: colors.brand[600],
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    alignItems: "center",
  },
  addBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },

  // Product picker modal
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
  productRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  productRowName: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  productRowUnit: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
