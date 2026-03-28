import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useOrder,
  useConfirmOrder,
  useCancelOrder,
  useUpdateOrderItems,
  type OrderItem,
} from "../../../lib/api/orders";
import { format } from "date-fns";
import { ProductPickerModal, type PickedProduct } from "../../../components/ProductPickerModal";
import { ProductImage } from "../../../components/ProductImage";

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  PENDING:           { label: "Pending",          bg: "#fef3c7", text: "#92400e" },
  CONFIRMED:         { label: "Confirmed",        bg: "#dbeafe", text: "#1e40af" },
  OUT_FOR_DELIVERY:  { label: "Out for Delivery", bg: "#ede9fe", text: "#5b21b6" },
  DELIVERED:         { label: "Delivered",        bg: "#d1fae5", text: "#065f46" },
  CANCELLED:         { label: "Cancelled",        bg: "#fee2e2", text: "#991b1b" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, bg: "#f1f5f9", text: "#64748b" };
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.badgeText, { color: cfg.text }]}>{cfg.label}</Text>
    </View>
  );
}

// ─── Editable line item ───────────────────────────────────────────────────────

function LineItemRow({
  item,
  editable,
  isRemoved,
  onQtyChange,
  onRemove,
  onRestore,
}: {
  item: OrderItem & { _localQty?: number };
  editable: boolean;
  isRemoved?: boolean;
  onQtyChange: (productId: string, qty: number) => void;
  onRemove: (productId: string) => void;
  onRestore: (productId: string) => void;
}) {
  const qty = Number(item._localQty ?? item.qty);
  const lineTotal = qty * parseFloat(String(item.unitPrice));

  const thumbUri = (item.product as any)?.thumbnailUrl ?? null;

  return (
    <View style={[styles.lineItem, isRemoved && styles.lineItemRemoved]}>
      {thumbUri ? (
        <View style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", marginRight: 10, flexShrink: 0 }}>
          {/* eslint-disable-next-line @typescript-eslint/no-var-requires */}
          <ProductImage uri={thumbUri} size="sm" style={{ width: 44, height: 44 }} />
        </View>
      ) : null}
      <View style={styles.lineItemLeft}>
        <Text style={[styles.lineItemName, isRemoved && styles.lineItemNameStruck]}>
          {item.product?.name ?? "Product"}
        </Text>
        {!isRemoved && (
          <Text style={styles.lineItemMeta}>
            {item.product?.unit ?? ""} · ${parseFloat(String(item.unitPrice)).toFixed(2)} each
          </Text>
        )}
        {isRemoved ? (
          <Text style={styles.lineItemRemovedLabel}>Will be removed on save</Text>
        ) : (
          <Text style={styles.lineItemStatus}>{item.status}</Text>
        )}
      </View>
      {editable ? (
        isRemoved ? (
          <Pressable style={styles.restoreBtn} onPress={() => onRestore(item.productId)} accessibilityLabel="Restore item">
            <Ionicons name="arrow-undo-outline" size={14} color={colors.brand[500]} />
            <Text style={styles.restoreBtnText}>Undo</Text>
          </Pressable>
        ) : (
          <View style={styles.qtyControl}>
            <Pressable
              style={[styles.qtyBtn, qty <= 1 && styles.qtyBtnDisabled]}
              onPress={() => onQtyChange(item.productId, Math.max(1, qty - 1))}
              disabled={qty <= 1}
            >
              <Ionicons name="remove" size={14} color={qty <= 1 ? "#cbd5e1" : colors.navy.DEFAULT} />
            </Pressable>
            <Text style={styles.qtyText}>{qty}</Text>
            <Pressable
              style={styles.qtyBtn}
              onPress={() => onQtyChange(item.productId, qty + 1)}
            >
              <Ionicons name="add" size={14} color={colors.brand[500]} />
            </Pressable>
            <Pressable
              style={styles.removeBtn}
              onPress={() => onRemove(item.productId)}
              accessibilityLabel="Remove item"
            >
              <Ionicons name="trash-outline" size={16} color="#dc2626" />
            </Pressable>
          </View>
        )
      ) : (
        <View style={styles.qtyReadOnly}>
          <Text style={styles.qtyReadOnlyText}>×{qty}</Text>
          <Text style={styles.lineTotalText}>${lineTotal.toFixed(2)}</Text>
        </View>
      )}
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function OrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();

  const { data: order, isLoading, refetch } = useOrder(orderId ?? "");
  const { mutate: confirmOrder, isPending: isConfirming } = useConfirmOrder();
  const { mutate: cancelOrder, isPending: isCancelling } = useCancelOrder();
  const { mutate: updateItems, isPending: isSavingItems } = useUpdateOrderItems();

  // Local editable qty state — keyed by productId
  const [localQtys, setLocalQtys] = useState<Record<string, number>>({});
  const [removedProductIds, setRemovedProductIds] = useState<string[]>([]);
  const [hasEdits, setHasEdits] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);

  const handleQtyChange = (productId: string, qty: number) => {
    setLocalQtys((prev) => ({ ...prev, [productId]: qty }));
    setHasEdits(true);
  };

  const handleRemoveItem = (productId: string) => {
    setRemovedProductIds((prev) => [...prev, productId]);
    setHasEdits(true);
  };

  const handleRestoreItem = (productId: string) => {
    setRemovedProductIds((prev) => prev.filter((id) => id !== productId));
    setHasEdits(true);
  };

  const handleSaveItems = () => {
    if (!order) return;
    const items = order.lineItems
      .filter((item) => !removedProductIds.includes(item.productId))
      .map((item) => ({
        productId: item.productId,
        qty: Number(localQtys[item.productId] ?? item.qty),
        unitPrice: parseFloat(String(item.unitPrice)),
      }));
    updateItems(
      { orderId: order.id, items },
      {
        onSuccess: () => {
          setLocalQtys({});
          setRemovedProductIds([]);
          setHasEdits(false);
          refetch();
        },
        onError: (err: any) => {
          Alert.alert("Error", err?.response?.data?.message ?? "Failed to save changes.");
        },
      },
    );
  };

  const handleDiscardChanges = () => {
    setLocalQtys({});
    setRemovedProductIds([]);
    setHasEdits(false);
  };

  const handleConfirm = () => {
    if (!order) return;
    confirmOrder(order.id, {
      onSuccess: () => refetch(),
      onError: (err: any) => {
        Alert.alert("Error", err?.response?.data?.message ?? "Failed to confirm order.");
      },
    });
  };

  const handleCancel = () => {
    if (!order) return;
    Alert.alert(
      "Cancel Order",
      "Are you sure you want to cancel this order? This cannot be undone.",
      [
        { text: "Keep Order", style: "cancel" },
        {
          text: "Cancel Order",
          style: "destructive",
          onPress: () =>
            cancelOrder(order.id, {
              onSuccess: () => router.back(),
              onError: (err: any) => {
                Alert.alert("Error", err?.response?.data?.message ?? "Failed to cancel order.");
              },
            }),
        },
      ],
    );
  };

  const handleAddProduct = (product: PickedProduct, qty: number) => {
    if (!order) return;
    const existingItem = order.lineItems.find((i) => i.productId === product.id);
    // If the product was marked for removal, restore it instead of adding again
    if (existingItem && removedProductIds.includes(product.id)) {
      setRemovedProductIds((prev) => prev.filter((id) => id !== product.id));
      setLocalQtys((prev) => ({ ...prev, [product.id]: Number(localQtys[product.id] ?? existingItem.qty) + qty }));
      setHasEdits(true);
      setShowProductPicker(false);
      return;
    }
    const items = [
      ...order.lineItems
        .filter((i) => !removedProductIds.includes(i.productId))
        .map((i) => ({
          productId: i.productId,
          qty: i.productId === product.id
            ? Number(localQtys[i.productId] ?? i.qty) + qty
            : Number(localQtys[i.productId] ?? i.qty),
          unitPrice: parseFloat(String(i.unitPrice)),
        })),
      ...(!existingItem ? [{ productId: product.id, qty: Number(qty), unitPrice: parseFloat(product.pricePerUnit) }] : []),
    ];
    updateItems(
      { orderId: order.id, items },
      {
        onSuccess: () => {
          setLocalQtys({});
          setRemovedProductIds([]);
          setHasEdits(false);
          refetch();
        },
        onError: (err: any) => {
          Alert.alert("Error", err?.response?.data?.message ?? "Failed to add item.");
        },
      },
    );
    setShowProductPicker(false);
  };

  const isPending = order?.status === "PENDING";
  const isEditable = isPending;

  const subtotal = order?.lineItems?.reduce((sum, item) => {
    if (removedProductIds.includes(item.productId)) return sum;
    const qty = localQtys[item.productId] ?? item.qty;
    return sum + qty * parseFloat(String(item.unitPrice));
  }, 0) ?? 0;

  return (
    <>
      <Stack.Screen
        options={{
          title: order ? `Order #${order.orderNumber}` : "Order",
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              style={{ paddingLeft: 4, paddingRight: 12, paddingVertical: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Ionicons name="arrow-back" size={24} color={colors.navy.DEFAULT} />
            </Pressable>
          ),
        }}
      />

      {isLoading || !order ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      ) : (
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Header card */}
          <View style={styles.headerCard}>
            <View style={styles.headerTop}>
              <Text style={styles.orderNumber}>#{order.orderNumber}</Text>
              <StatusBadge status={order.status} />
              {order.urgent && (
                <View style={styles.urgentTag}>
                  <Ionicons name="flash" size={11} color="#b45309" />
                  <Text style={styles.urgentText}>Urgent</Text>
                </View>
              )}
            </View>
            <Text style={styles.orderDate}>
              Created {format(new Date(order.createdAt), "MMM d, yyyy 'at' h:mm a")}
            </Text>
            {order.requestedDeliveryDate && (
              <Text style={styles.deliveryDate}>
                Requested delivery: {format(new Date(order.requestedDeliveryDate), "MMM d, yyyy")}
              </Text>
            )}
          </View>

          {/* Line items */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Items</Text>
              {isEditable && (
                <Text style={styles.sectionHint}>Tap +/− to edit quantities</Text>
              )}
            </View>
            {order.lineItems.map((item) => (
              <LineItemRow
                key={item.id}
                item={{ ...item, _localQty: localQtys[item.productId] }}
                editable={isEditable}
                isRemoved={removedProductIds.includes(item.productId)}
                onQtyChange={handleQtyChange}
                onRemove={handleRemoveItem}
                onRestore={handleRestoreItem}
              />
            ))}
            {order.lineItems.length === 0 && (
              <Text style={styles.noItems}>No items on this order</Text>
            )}
            {isEditable && (
              <Pressable style={styles.addItemBtn} onPress={() => setShowProductPicker(true)}>
                <Ionicons name="add-circle-outline" size={18} color={colors.brand[500]} />
                <Text style={styles.addItemText}>Add item</Text>
              </Pressable>
            )}
          </View>

          {/* Totals */}
          <View style={styles.totalsCard}>
            {hasEdits ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Estimated Subtotal</Text>
                <Text style={styles.totalValue}>${subtotal.toFixed(2)}</Text>
              </View>
            ) : (
              <>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Subtotal</Text>
                  <Text style={styles.totalValue}>${parseFloat(String(order.subtotal)).toFixed(2)}</Text>
                </View>
                {parseFloat(String(order.tax)) > 0 && (
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>Tax</Text>
                    <Text style={styles.totalValue}>${parseFloat(String(order.tax)).toFixed(2)}</Text>
                  </View>
                )}
                <View style={[styles.totalRow, styles.totalRowFinal]}>
                  <Text style={styles.totalLabelFinal}>Total</Text>
                  <Text style={styles.totalValueFinal}>${parseFloat(String(order.total)).toFixed(2)}</Text>
                </View>
              </>
            )}
          </View>

          {/* Notes */}
          {order.notes ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Notes</Text>
              <Text style={styles.notesText}>{order.notes}</Text>
            </View>
          ) : null}

          {order.driverNote ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Driver Note</Text>
              <Text style={styles.notesText}>{order.driverNote}</Text>
            </View>
          ) : null}

          {/* Save / Discard edits */}
          {hasEdits && (
            <View style={styles.editActions}>
              <Pressable
                style={[styles.saveBtn, { flex: 1 }, isSavingItems && styles.btnDisabled]}
                onPress={handleSaveItems}
                disabled={isSavingItems}
              >
                {isSavingItems ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="save-outline" size={20} color="#fff" />
                    <Text style={styles.saveBtnText}>Save</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                style={[styles.discardBtn, isSavingItems && styles.btnDisabled]}
                onPress={handleDiscardChanges}
                disabled={isSavingItems}
              >
                <Ionicons name="close-outline" size={20} color="#64748b" />
                <Text style={styles.discardBtnText}>Discard</Text>
              </Pressable>
            </View>
          )}

          {/* Action buttons */}
          {isPending && (
            <View style={styles.actions}>
              <Pressable
                style={[styles.confirmBtn, (isConfirming || hasEdits) && styles.btnDisabled]}
                onPress={handleConfirm}
                disabled={isConfirming || hasEdits}
              >
                {isConfirming ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="checkmark-circle-outline" size={22} color="#fff" />
                    <Text style={styles.confirmBtnText}>Confirm Order</Text>
                  </>
                )}
              </Pressable>
              {hasEdits && (
                <Text style={styles.saveFirstHint}>Save changes before confirming</Text>
              )}
              <Pressable
                style={[styles.cancelBtn, isCancelling && styles.btnDisabled]}
                onPress={handleCancel}
                disabled={isCancelling}
              >
                {isCancelling ? (
                  <ActivityIndicator size="small" color="#991b1b" />
                ) : (
                  <>
                    <Ionicons name="close-circle-outline" size={20} color="#dc2626" />
                    <Text style={styles.cancelBtnText}>Cancel Order</Text>
                  </>
                )}
              </Pressable>
            </View>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      <ProductPickerModal
        visible={showProductPicker}
        onClose={() => setShowProductPicker(false)}
        title="Add Item to Order"
        onSelect={handleAddProduct}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  scroll: {
    padding: 16,
    gap: 12,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 6,
    ...shadows.card,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  orderNumber: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  urgentTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#fef3c7",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  urgentText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#b45309",
  },
  orderDate: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  deliveryDate: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 4,
    ...shadows.card,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  lineItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  lineItemRemoved: {
    opacity: 0.5,
    backgroundColor: "#fff1f2",
    marginHorizontal: -4,
    paddingHorizontal: 4,
    borderRadius: 6,
  },
  lineItemLeft: {
    flex: 1,
    gap: 2,
  },
  lineItemName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  lineItemNameStruck: {
    textDecorationLine: "line-through",
    color: "#94a3b8",
  },
  lineItemRemovedLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#dc2626",
  },
  lineItemMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  removeBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 2,
  },
  restoreBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.brand[500],
  },
  restoreBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  lineItemStatus: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textTransform: "capitalize",
  },
  qtyControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  qtyBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
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
    minWidth: 22,
    textAlign: "center",
  },
  qtyReadOnly: {
    alignItems: "flex-end",
    gap: 2,
  },
  qtyReadOnlyText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  lineTotalText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  noItems: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    paddingVertical: 8,
    textAlign: "center",
  },
  totalsCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 8,
    ...shadows.card,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  totalRowFinal: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    paddingTop: 8,
    marginTop: 4,
  },
  totalLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  totalValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  totalLabelFinal: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  totalValueFinal: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  notesText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    lineHeight: 22,
    paddingTop: 4,
  },
  editActions: {
    flexDirection: "row",
    gap: 10,
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    height: 50,
  },
  saveBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  discardBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    height: 50,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  discardBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
  actions: {
    gap: 10,
  },
  confirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#16a34a",
    borderRadius: borderRadius.DEFAULT,
    height: 52,
  },
  confirmBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  saveFirstHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
  },
  cancelBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    height: 50,
    borderWidth: 1.5,
    borderColor: "#fca5a5",
    ...shadows.card,
  },
  cancelBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#dc2626",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    marginTop: 4,
  },
  addItemText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.brand[500],
  },
});
