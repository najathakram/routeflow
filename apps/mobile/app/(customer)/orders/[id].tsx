import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useBuyerOrder,
  useBuyerCancelOrder,
  useBuyerCreateChangeRequest,
  useBuyerCreateOrder,
  useBuyerOrderTracking,
} from "../../../lib/api/buyer";
import {
  orderEditable,
  orderCancellable,
  canRequestChange,
  changeRequestChip,
  describeChangeRequest,
  describeResolution,
} from "../../../lib/shelf-logic";
import {
  buildReorderItems,
  canReorder,
  trackingStepIndex,
} from "../../../lib/order-tracking-logic";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function orderPill(status: string) {
  switch (status) {
    case "PENDING":
      return { variant: "orange" as const, label: "Pending" };
    case "CONFIRMED":
      return { variant: "brand" as const, label: "Confirmed" };
    case "DRAFT":
      return { variant: "gray" as const, label: "Draft" };
    case "OUT_FOR_DELIVERY":
      return { variant: "brand" as const, label: "Out for delivery" };
    case "IN_TRANSIT":
      return { variant: "brand" as const, label: "In transit" };
    case "DELIVERED":
      return { variant: "green" as const, label: "Delivered" };
    case "CANCELLED":
      return { variant: "gray" as const, label: "Cancelled" };
    default:
      return { variant: "gray" as const, label: status };
  }
}

/** Map the P5-08/09 409 error codes to friendly copy. */
function friendlyChangeRequestError(e: any): string {
  const code = e?.response?.data?.code ?? e?.response?.data?.error;
  if (code === "EDIT_WINDOW_OPEN") {
    return "This order can still be edited directly — use Edit items instead.";
  }
  if (code === "CHANGE_WINDOW_CLOSED") {
    return "This order is no longer accepting change requests.";
  }
  return e?.response?.data?.message ?? e?.message ?? "Try again.";
}

export default function CustomerOrderDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading, isError } = useBuyerOrder(id);
  const cancelMut = useBuyerCancelOrder();
  const createCrMut = useBuyerCreateChangeRequest();
  const { data: tracking } = useBuyerOrderTracking(id);
  const reorderMut = useBuyerCreateOrder();
  const [crModalOpen, setCrModalOpen] = useState(false);
  const [crNote, setCrNote] = useState("");

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Order"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Order"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <Text style={styles.notFoundTitle}>Order not found</Text>
          <Pressable
            onPress={() => router.replace("/(customer)/(tabs)/orders")}
            style={styles.notFoundBtn}
          >
            <Text style={styles.notFoundBtnText}>Back to orders</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const p = orderPill(order.status);
  const total =
    Number(order.total) ||
    order.lineItems.reduce(
      (s, i) => s + (i.subtotal != null ? Number(i.subtotal) : Number(i.qty) * Number(i.unitPrice)),
      0,
    );
  const canCancel = orderCancellable(order);
  const canEdit = orderEditable(order);
  const canRequest = !canEdit && canRequestChange(order);
  const canDoReorder = canReorder(order) && buildReorderItems(order).length > 0;

  const onReorder = () =>
    confirm(
      "Reorder this order?",
      "A new order will be created with the same items.",
      () =>
        reorderMut.mutate(
          { items: buildReorderItems(order) },
          {
            onSuccess: (newOrder) => {
              showToast("Order created");
              router.push(`/(customer)/orders/${newOrder.id}`);
            },
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
          },
        ),
      { confirmText: "Reorder" },
    );

  const onCancel = () =>
    confirm(
      "Cancel order?",
      "This cannot be undone.",
      () =>
        cancelMut.mutate(id, {
          onSuccess: () => {
            showToast("Order cancelled");
            router.back();
          },
          onError: (e: any) => showToast(friendlyChangeRequestError(e)),
        }),
      { confirmText: "Cancel order", destructive: true },
    );

  const onSubmitChangeRequest = () => {
    const note = crNote.trim();
    if (!note) return;
    createCrMut.mutate(
      { orderId: id, type: "NOTE", note },
      {
        onSuccess: () => {
          showToast("Change request sent");
          setCrModalOpen(false);
          setCrNote("");
        },
        onError: (e: any) => showToast(friendlyChangeRequestError(e)),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Order"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderNum}>
                {order.orderNumber ? `#${order.orderNumber}` : "Order"}
              </Text>
              <Text style={styles.orderDate}>
                {new Date(order.createdAt).toLocaleDateString(undefined, {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </Text>
            </View>
            <Pill variant={p.variant} dot>
              {p.label}
            </Pill>
          </View>
          {order.subtotal != null && order.tax != null ? (
            <View style={{ marginTop: 4 }}>
              <Text style={styles.totalLine}>Subtotal: ${Number(order.subtotal).toFixed(2)}</Text>
              <Text style={styles.totalLine}>GST (10%): ${Number(order.tax).toFixed(2)}</Text>
            </View>
          ) : null}
          <Text style={styles.total}>${total.toFixed(2)}</Text>
          {order.requestedDeliveryDate ? (
            <Text style={styles.deliveryDate}>
              Delivery:{" "}
              {new Date(order.requestedDeliveryDate).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </Text>
          ) : null}
          {order.notes ? <Text style={styles.notes}>{order.notes}</Text> : null}
        </View>

        {/* Delivery tracking */}
        {order.status !== "DRAFT" && order.status !== "CANCELLED" ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Delivery tracking</Text>
            </View>
            <View style={styles.trackingCard}>
              <View style={styles.trackingSteps}>
                {["Pending", "Confirmed", "Out for delivery", "Partial", "Delivered"].map(
                  (label, idx) => {
                    const stepIdx = trackingStepIndex(order.status);
                    const done = stepIdx >= idx;
                    return (
                      <View key={label} style={styles.trackingStep}>
                        <View style={[styles.trackingDot, done && styles.trackingDotDone]} />
                        <Text
                          style={[styles.trackingStepLabel, done && styles.trackingStepLabelDone]}
                        >
                          {label}
                        </Text>
                      </View>
                    );
                  },
                )}
              </View>

              {tracking?.tracking ? (
                <View style={styles.trackingLive}>
                  {tracking.tracking.driverName ? (
                    <Text style={styles.trackingLine}>Driver: {tracking.tracking.driverName}</Text>
                  ) : null}
                  {tracking.tracking.runStatus === "IN_PROGRESS" ? (
                    <Text style={styles.trackingLine}>
                      {tracking.tracking.stopsAhead === 0
                        ? "You're next on the route"
                        : `${tracking.tracking.stopsAhead} stop${tracking.tracking.stopsAhead === 1 ? "" : "s"} ahead of you`}
                    </Text>
                  ) : null}
                  {tracking.tracking.estimatedArrivalWindow.start ? (
                    <Text style={styles.trackingLine}>
                      Estimated: {tracking.tracking.estimatedArrivalWindow.start}
                      {tracking.tracking.estimatedArrivalWindow.end
                        ? ` – ${tracking.tracking.estimatedArrivalWindow.end}`
                        : ""}
                    </Text>
                  ) : null}
                  <View style={styles.trackingMapPlaceholder}>
                    <Ionicons name="map-outline" size={20} color={ios.label3} />
                    <Text style={styles.trackingMapText}>Live map coming soon</Text>
                  </View>
                </View>
              ) : order.status === "CONFIRMED" ? (
                <Text style={styles.trackingLine}>Not yet on a delivery route.</Text>
              ) : null}
            </View>
          </>
        ) : null}

        {/* Line items */}
        {order.lineItems.length > 0 ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Items</Text>
            </View>
            <View style={styles.itemsList}>
              {order.lineItems.map((item, i) => (
                <View
                  key={item.id}
                  style={[
                    styles.itemRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {item.product?.name ?? "Product"}
                    </Text>
                    <Text style={styles.itemMeta}>
                      {item.boxes != null
                        ? `${item.boxes} box${item.boxes === 1 ? "" : "es"}${
                            item.pieces ? ` + ${item.pieces}` : ""
                          } × $${Number(item.unitPrice).toFixed(2)}`
                        : `${Number(item.qty)} × $${Number(item.unitPrice).toFixed(2)}`}
                      {item.product?.unit ? ` / ${item.product.unit}` : ""}
                    </Text>
                  </View>
                  <Text style={styles.itemTotal}>
                    $
                    {(item.subtotal != null
                      ? Number(item.subtotal)
                      : Number(item.qty) * Number(item.unitPrice)
                    ).toFixed(2)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* Edit items */}
        {canEdit ? (
          <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
            <Pressable
              style={styles.editBtn}
              onPress={() => router.push(`/(customer)/orders/${id}/edit-items` as any)}
            >
              <Text style={styles.editBtnText}>Edit items</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Cancel */}
        {canCancel ? (
          <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
            <Pressable style={styles.cancelBtn} onPress={onCancel} disabled={cancelMut.isPending}>
              <Text style={styles.cancelBtnText}>
                {cancelMut.isPending ? "Cancelling…" : "Cancel order"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Reorder — places a new order from this one's items (server re-prices) */}
        {canDoReorder ? (
          <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
            <Pressable style={styles.editBtn} onPress={onReorder} disabled={reorderMut.isPending}>
              <Text style={styles.editBtnText}>
                {reorderMut.isPending ? "Placing order…" : "Reorder"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Request a change — post-dispatch, free-text NOTE only (NO prices/product search) */}
        {canRequest ? (
          <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
            <Pressable style={styles.editBtn} onPress={() => setCrModalOpen(true)}>
              <Text style={styles.editBtnText}>Request a change</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Change requests */}
        {order.changeRequests && order.changeRequests.length > 0 ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Change requests</Text>
            </View>
            <View style={styles.itemsList}>
              {order.changeRequests.map((cr, i) => {
                const { title, detail } = describeChangeRequest(cr, order.lineItems);
                const chip = changeRequestChip(cr.status);
                const resolution = describeResolution(cr);
                return (
                  <View
                    key={cr.id}
                    style={[
                      styles.crRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>{title}</Text>
                      {detail ? <Text style={styles.itemMeta}>{detail}</Text> : null}
                      {resolution ? <Text style={styles.itemMeta}>{resolution}</Text> : null}
                    </View>
                    <Pill variant={chip.variant} small>
                      {chip.label}
                    </Pill>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Free-text NOTE composer — NO prices, NO product search */}
      <Modal
        visible={crModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setCrModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Request a change</Text>
            <Text style={styles.itemMeta}>
              Tell your driver or the seller what you'd like changed. No prices — the seller will
              confirm the details.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={crNote}
              onChangeText={(t) => setCrNote(t.slice(0, 1000))}
              placeholder="e.g. Please add 2 more boxes of..."
              placeholderTextColor={ios.label2}
              multiline
              maxLength={1000}
            />
            <View style={styles.modalActions}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnCancel]}
                onPress={() => {
                  setCrModalOpen(false);
                  setCrNote("");
                }}
              >
                <Text style={styles.modalBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnSubmit]}
                onPress={onSubmitChangeRequest}
                disabled={createCrMut.isPending || !crNote.trim()}
              >
                <Text style={styles.modalBtnSubmitText}>
                  {createCrMut.isPending ? "Sending…" : "Send"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundTitle: { fontSize: 17, color: "#333", marginBottom: 16 },
  notFoundBtn: { paddingVertical: 10, paddingHorizontal: 20 },
  notFoundBtnText: { fontSize: 15, color: "#007AFF" },
  editBtn: {
    borderWidth: 1,
    borderColor: "#007AFF",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  editBtnText: { color: "#007AFF", fontSize: 15, fontWeight: "600" },
  headerCard: { margin: 16, backgroundColor: ios.bgElev, borderRadius: 16, padding: 18, gap: 6 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  orderNum: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  orderDate: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  totalLine: { fontSize: 13, color: ios.label2, marginTop: 2 },
  total: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.6,
    marginTop: 4,
  },
  deliveryDate: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  notes: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  sectionRow: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  itemsList: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
  },
  itemRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  itemName: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  itemMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  cancelBtn: {
    backgroundColor: ios.fill3,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelBtnText: { color: ios.system.redInk, fontSize: 15, fontFamily: "Inter_500Medium" },
  crRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 10,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  modalInput: {
    minHeight: 100,
    borderWidth: 1,
    borderColor: ios.separator,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    textAlignVertical: "top",
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  modalBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  modalBtnCancel: { backgroundColor: ios.fill3 },
  modalBtnCancelText: { color: ios.label, fontSize: 15, fontFamily: "Inter_500Medium" },
  modalBtnSubmit: { backgroundColor: ios.brand },
  modalBtnSubmitText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  trackingCard: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  trackingSteps: { flexDirection: "row", justifyContent: "space-between" },
  trackingStep: { alignItems: "center", flex: 1, gap: 4 },
  trackingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: ios.fill3 },
  trackingDotDone: { backgroundColor: ios.brand },
  trackingStepLabel: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: ios.label3,
    textAlign: "center",
  },
  trackingStepLabelDone: { color: ios.brand },
  trackingLive: {
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    paddingTop: 10,
  },
  trackingLine: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  trackingMapPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 16,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    marginTop: 4,
  },
  trackingMapText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3 },
});
