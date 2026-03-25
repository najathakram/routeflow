import { useState } from "react";
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
import { router, Stack } from "expo-router";
import { format, addDays } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { EmptyState } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useOrderStore } from "../../../store/orderStore";
import { useMyOrders, useCreateOrder, useUpdateOrderItems, useOrderTracking } from "../../../lib/api/orders";

const DATE_OPTIONS = [
  { label: "Today", offset: 0 },
  { label: "Tomorrow", offset: 1 },
  { label: "+2 days", offset: 2 },
  { label: "+3 days", offset: 3 },
];

function QtyStepper({
  value,
  onDecrease,
  onIncrease,
}: {
  value: number;
  onDecrease: () => void;
  onIncrease: () => void;
}) {
  return (
    <View style={stepperStyles.row}>
      <Pressable
        onPress={onDecrease}
        style={stepperStyles.btn}
        hitSlop={6}
      >
        <Text style={stepperStyles.btnText}>−</Text>
      </Pressable>
      <Text style={stepperStyles.count}>{value}</Text>
      <Pressable onPress={onIncrease} style={stepperStyles.btn} hitSlop={6}>
        <Text style={stepperStyles.btnText}>+</Text>
      </Pressable>
    </View>
  );
}

const stepperStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  btn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  btnText: {
    fontSize: 16,
    lineHeight: 20,
    color: colors.navy.DEFAULT,
    fontFamily: "Inter_600SemiBold",
  },
  count: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    minWidth: 20,
    textAlign: "center",
  },
});

function SubstitutionModal({
  productName,
  value,
  onSave,
  onClose,
}: {
  productName: string;
  value: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(value);

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={subStyles.overlay} onPress={onClose}>
        <Pressable style={subStyles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={subStyles.title}>Substitution Preference</Text>
          <Text style={subStyles.subtitle}>
            If {productName} is unavailable, replace with:
          </Text>
          <TextInput
            style={subStyles.input}
            placeholder="e.g. Any similar brand, or skip"
            placeholderTextColor="#94a3b8"
            value={text}
            onChangeText={setText}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => { onSave(text); onClose(); }}
          />
          <View style={subStyles.actions}>
            <Pressable style={subStyles.cancelBtn} onPress={onClose}>
              <Text style={subStyles.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={subStyles.saveBtn}
              onPress={() => { onSave(text); onClose(); }}
            >
              <Text style={subStyles.saveBtnText}>Save</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const subStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  sheet: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 24,
    width: "100%",
    gap: 12,
    ...shadows.card,
  },
  title: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    lineHeight: 18,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    flex: 1,
    height: 44,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  saveBtn: {
    flex: 1,
    height: 44,
    borderRadius: borderRadius.DEFAULT,
    backgroundColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
});

export default function OrderScreen() {
  const {
    items, isUrgent, notes, requestedDeliveryDate, editingOrderId,
    itemNotes, substitutions,
    removeItem, updateQuantity, setUrgent, setNotes, setRequestedDeliveryDate,
    setItemNote, setSubstitution, clearOrder,
  } = useOrderStore();
  const { mutate: createOrder, isPending: isCreating } = useCreateOrder();
  const { mutate: updateOrderItems, isPending: isUpdating } = useUpdateOrderItems();
  const isSubmitting = isCreating || isUpdating;

  // Fetch pending orders from the API so the server state is always in sync
  const { data: pendingOrdersData, isLoading: pendingLoading } = useMyOrders({ status: "PENDING" });
  const pendingOrders = pendingOrdersData?.data ?? [];

  // Fetch out-for-delivery orders for ETA banner
  const { data: outForDeliveryData } = useMyOrders({ status: "OUT_FOR_DELIVERY" });
  const outForDeliveryOrder = outForDeliveryData?.data?.[0] ?? null;
  const { data: trackingData } = useOrderTracking(
    outForDeliveryOrder?.id ?? "",
    outForDeliveryOrder?.status,
  );

  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [subModalProductId, setSubModalProductId] = useState<string | null>(null);

  const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  const subModalItem = subModalProductId
    ? items.find((i) => i.productId === subModalProductId) ?? null
    : null;

  const handlePlaceOrder = () => {
    if (items.length === 0) return;

    if (editingOrderId) {
      updateOrderItems(
        {
          orderId: editingOrderId,
          items: items.map((i) => ({
            productId: i.productId,
            qty: i.quantity,
            unitPrice: i.unitPrice,
            itemNote: itemNotes[i.productId] || undefined,
            substitution: substitutions[i.productId] || undefined,
          })),
        },
        {
          onSuccess: () => {
            clearOrder();
            router.replace("/(customer)/history" as any);
          },
          onError: (err) => {
            Alert.alert("Error", "Failed to update order. Please try again.\n" + (err.message || ""));
          },
        },
      );
    } else {
      createOrder(
        {
          items: items.map((i) => ({
            productId: i.productId,
            qty: i.quantity,
            itemNote: itemNotes[i.productId] || undefined,
            substitution: substitutions[i.productId] || undefined,
          })),
          notes: notes || undefined,
          urgent: isUrgent || undefined,
          requestedDeliveryDate: requestedDeliveryDate || undefined,
          substitutions: Object.keys(substitutions).length > 0 ? substitutions : undefined,
        } as any,
        {
          onSuccess: (order) => {
            clearOrder();
            router.replace(`/(customer)/order/confirmation?orderId=${order.id}` as any);
          },
          onError: (err) => {
            Alert.alert("Error", "Failed to place order. Please try again.\n" + (err.message || ""));
          },
        },
      );
    }
  };

  if (items.length === 0) {
    return (
      <>
        <Stack.Screen options={{ title: "My Order" }} />
        {pendingLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.brand[500]} />
          </View>
        ) : pendingOrders.length > 0 || outForDeliveryOrder ? (
          // Show the first pending/out-for-delivery order from the server
          <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
              {/* ETA Banner — shown when an order is out for delivery */}
              {outForDeliveryOrder && trackingData?.tracking ? (
                <View style={styles.etaBanner}>
                  <View style={styles.etaBannerHeader}>
                    <Ionicons name="car-outline" size={20} color={colors.brand[500]} />
                    <Text style={styles.etaBannerTitle}>
                      {trackingData.tracking.stopsAhead === 0
                        ? "Your delivery is next!"
                        : `Your delivery is ${trackingData.tracking.stopsAhead} stop${trackingData.tracking.stopsAhead !== 1 ? "s" : ""} away`}
                    </Text>
                  </View>
                  {trackingData.tracking.driverName ? (
                    <Text style={styles.etaBannerDriver}>
                      Driver: {trackingData.tracking.driverName}
                    </Text>
                  ) : null}
                </View>
              ) : outForDeliveryOrder && !trackingData?.tracking ? (
                <View style={styles.etaBanner}>
                  <View style={styles.etaBannerHeader}>
                    <Ionicons name="car-outline" size={20} color={colors.brand[500]} />
                    <Text style={styles.etaBannerTitle}>Your order is out for delivery!</Text>
                  </View>
                </View>
              ) : null}
              {pendingOrders.length > 0 ? (
                <>
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Pending Order</Text>
                    {pendingOrders[0].lineItems.map((item) => (
                      <View key={item.id} style={styles.lineItem}>
                        <View style={styles.lineItemLeft}>
                          <Text style={styles.lineItemName}>{item.product?.name ?? item.productId}</Text>
                          <Text style={styles.lineItemUnit}>{item.product?.unit ?? ""}</Text>
                          <Text style={styles.lineItemPrice}>
                            ${Number(item.unitPrice).toFixed(2)} each
                          </Text>
                        </View>
                        <View style={styles.lineItemRight}>
                          <Text style={styles.lineItemSubtotal}>
                            ${(item.qty * Number(item.unitPrice)).toFixed(2)}
                          </Text>
                          <Text style={styles.qtyLabel}>Qty: {item.qty}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                  <View style={[styles.section, styles.totalsSection]}>
                    <Text style={styles.sectionTitle}>Order Summary</Text>
                    <View style={styles.totalRow}>
                      <Text style={styles.totalLabel}>Total</Text>
                      <Text style={styles.grandValue}>${Number(pendingOrders[0].total).toFixed(2)}</Text>
                    </View>
                  </View>
                </>
              ) : null}
            </ScrollView>
          </View>
        ) : (
          <EmptyState
            icon={<Ionicons name="clipboard-outline" size={56} color="#cbd5e1" />}
            title="Your order is empty"
            subtitle="Browse the shop and add items to build your order."
            actionLabel="Start Shopping"
            onActionPress={() => router.push("/(customer)/shop")}
          />
        )}
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "My Order" }} />
      <View style={styles.outerContainer}>
        <View style={styles.container}>
        {/* Urgent banner */}
        {isUrgent ? (
          <View style={styles.urgentBanner}>
            <Ionicons name="alert-circle" size={16} color={colors.danger.DEFAULT} />
            <Text style={styles.urgentBannerText}>
              Marked as Urgent — this order will be prioritised.
            </Text>
          </View>
        ) : null}

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Urgent toggle */}
          <View style={styles.urgentToggleRow}>
            <View style={styles.urgentLabel}>
              <Ionicons
                name="flash-outline"
                size={18}
                color={isUrgent ? colors.danger.DEFAULT : "#64748b"}
              />
              <Text
                style={[
                  styles.urgentText,
                  isUrgent && { color: colors.danger.DEFAULT },
                ]}
              >
                Mark as Urgent
              </Text>
            </View>
            <Switch
              value={isUrgent}
              onValueChange={setUrgent}
              trackColor={{
                false: colors.surface.border,
                true: colors.danger.DEFAULT,
              }}
              thumbColor="#fff"
            />
          </View>

          {/* Line items */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Items ({itemCount})
            </Text>
            {items.map((item) => (
              <View key={item.productId}>
                <View style={styles.lineItem}>
                  <View style={styles.lineItemLeft}>
                    <Text style={styles.lineItemName}>{item.name}</Text>
                    <Text style={styles.lineItemUnit}>{item.unit}</Text>
                    <Text style={styles.lineItemPrice}>
                      ${item.unitPrice.toFixed(2)} each
                    </Text>
                  </View>
                  <View style={styles.lineItemRight}>
                    <Pressable
                      onPress={() => removeItem(item.productId)}
                      hitSlop={8}
                      style={styles.removeBtn}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={16}
                        color={colors.danger.DEFAULT}
                      />
                    </Pressable>
                    {/* Note button */}
                    <Pressable
                      onPress={() =>
                        setExpandedNoteId(
                          expandedNoteId === item.productId ? null : item.productId,
                        )
                      }
                      hitSlop={8}
                      style={styles.noteIconBtn}
                      accessibilityLabel={`Add note for ${item.name}`}
                    >
                      <Ionicons
                        name="create-outline"
                        size={16}
                        color={
                          itemNotes[item.productId]
                            ? colors.brand[500]
                            : "#94a3b8"
                        }
                      />
                    </Pressable>
                    {/* Sub button */}
                    <Pressable
                      onPress={() => setSubModalProductId(item.productId)}
                      hitSlop={8}
                      style={styles.noteIconBtn}
                      accessibilityLabel={`Substitution preference for ${item.name}`}
                    >
                      <Text
                        style={[
                          styles.subBtnText,
                          substitutions[item.productId] ? { color: colors.brand[500] } : {},
                        ]}
                      >
                        Sub
                      </Text>
                    </Pressable>
                    <QtyStepper
                      value={item.quantity}
                      onDecrease={() =>
                        updateQuantity(item.productId, item.quantity - 1)
                      }
                      onIncrease={() =>
                        updateQuantity(item.productId, item.quantity + 1)
                      }
                    />
                    <Text style={styles.lineItemSubtotal}>
                      ${(item.unitPrice * item.quantity).toFixed(2)}
                    </Text>
                  </View>
                </View>
                {expandedNoteId === item.productId && (
                  <TextInput
                    style={styles.itemNoteInput}
                    placeholder={`Note for ${item.name}…`}
                    placeholderTextColor="#94a3b8"
                    value={itemNotes[item.productId] ?? ""}
                    onChangeText={(v) => setItemNote(item.productId, v)}
                    autoFocus
                    returnKeyType="done"
                  />
                )}
                {substitutions[item.productId] ? (
                  <View style={styles.subNote}>
                    <Ionicons name="swap-horizontal-outline" size={12} color="#94a3b8" />
                    <Text style={styles.subNoteText} numberOfLines={1}>
                      Sub: {substitutions[item.productId]}
                    </Text>
                  </View>
                ) : null}
              </View>
            ))}
          </View>

          {/* Delivery Date */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Requested Delivery Date</Text>
            <View style={styles.dateRow}>
              {DATE_OPTIONS.map(({ label, offset }) => {
                const dateVal = format(addDays(new Date(), offset), "yyyy-MM-dd");
                const isSelected = requestedDeliveryDate === dateVal;
                return (
                  <Pressable
                    key={label}
                    style={[styles.dateChip, isSelected && styles.dateChipActive]}
                    onPress={() => setRequestedDeliveryDate(isSelected ? null : dateVal)}
                  >
                    <Text style={[styles.dateChipText, isSelected && styles.dateChipTextActive]}>
                      {label}
                    </Text>
                    {offset > 0 ? (
                      <Text style={[styles.dateChipSub, isSelected && styles.dateChipSubActive]}>
                        {format(addDays(new Date(), offset), "MMM d")}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Order notes */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Order Notes</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Add a note for your driver or admin…"
              placeholderTextColor="#94a3b8"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* Totals */}
          <View style={[styles.section, styles.totalsSection]}>
            <Text style={styles.sectionTitle}>Order Summary</Text>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Items</Text>
              <Text style={styles.totalValue}>{itemCount}</Text>
            </View>
            <View style={[styles.totalRow, styles.totalGrandRow]}>
              <Text style={styles.grandLabel}>Total</Text>
              <Text style={styles.grandValue}>${total.toFixed(2)}</Text>
            </View>
            <Text style={styles.rollingNote}>
              This is a rolling order — items can be added or removed any time
              before dispatch.
            </Text>
          </View>
        </ScrollView>
        </View>

        {/* Place Order footer */}
        <View style={styles.footer}>
          <Pressable
            style={[styles.placeOrderBtn, isSubmitting && { opacity: 0.7 }]}
            onPress={handlePlaceOrder}
            disabled={isSubmitting}
            accessibilityRole="button"
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <Ionicons name="checkmark-circle-outline" size={22} color="#fff" style={{ marginRight: 8 }} />
            )}
            <Text style={styles.placeOrderBtnText}>
              {isSubmitting
                ? editingOrderId ? "Updating Order…" : "Placing Order…"
                : editingOrderId
                  ? `Update Order · $${total.toFixed(2)}`
                  : `Place Order · $${total.toFixed(2)}`}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Substitution modal */}
      {subModalItem ? (
        <SubstitutionModal
          productName={subModalItem.name}
          value={substitutions[subModalItem.productId] ?? ""}
          onSave={(text) => setSubstitution(subModalItem.productId, text)}
          onClose={() => setSubModalProductId(null)}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  placeOrderBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  placeOrderBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  urgentBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.danger.bg,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#fca5a5",
  },
  urgentBannerText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.danger.DEFAULT,
    flex: 1,
  },
  etaBanner: {
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.lg,
    padding: 16,
    marginBottom: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: colors.brand[200] ?? colors.brand[500] + "33",
    ...shadows.card,
  },
  etaBannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  etaBannerTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.brand[600] ?? colors.brand[500],
    flex: 1,
  },
  etaBannerDriver: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    paddingLeft: 28,
  },
  scroll: {
    paddingBottom: 32,
  },
  urgentToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  urgentLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  urgentText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  section: {
    backgroundColor: "#fff",
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  lineItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  lineItemLeft: {
    flex: 1,
    paddingRight: 12,
  },
  lineItemName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    marginBottom: 2,
  },
  lineItemUnit: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginBottom: 4,
  },
  lineItemPrice: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  lineItemRight: {
    alignItems: "flex-end",
    gap: 8,
  },
  removeBtn: {
    padding: 4,
  },
  noteIconBtn: {
    padding: 4,
  },
  subBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    letterSpacing: 0.3,
  },
  itemNoteInput: {
    borderWidth: 1,
    borderColor: colors.brand[200] ?? colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.brand[50],
    marginBottom: 4,
  },
  subNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  subNoteText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    fontStyle: "italic",
    flex: 1,
  },
  lineItemSubtotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  qtyLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  dateRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  dateChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    minWidth: 72,
  },
  dateChipActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  dateChipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
  dateChipTextActive: {
    color: colors.brand[500],
  },
  dateChipSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: 1,
  },
  dateChipSubActive: {
    color: colors.brand[500],
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 80,
    backgroundColor: colors.surface.raised,
  },
  totalsSection: {
    ...shadows.card,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
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
  totalGrandRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    marginTop: 8,
    paddingTop: 12,
  },
  grandLabel: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  grandValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.brand[700],
  },
  rollingNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: 12,
    fontStyle: "italic",
  },
});
