import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useAdminOrder } from "../../../../lib/api/admin";
import {
  useChangeOrderStatus,
  useDeleteOrder,
  useToggleOrderUrgent,
  type OrderStatus,
} from "../../../../lib/api/orders";
import { showToast } from "../../../../lib/toast";
import { confirm } from "../../../../lib/confirm";

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function statusPill(status: string): {
  variant: "brand" | "green" | "orange" | "red" | "gray";
  label: string;
} {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "PENDING":
      return { variant: "orange", label: "Pending" };
    case "CONFIRMED":
      return { variant: "brand", label: "Confirmed" };
    case "OUT_FOR_DELIVERY":
      return { variant: "brand", label: "Out for delivery" };
    case "PARTIALLY_DELIVERED":
      return { variant: "orange", label: "Partial delivery" };
    case "DELIVERED":
      return { variant: "green", label: "Delivered" };
    case "CANCELLED":
      return { variant: "red", label: "Cancelled" };
    default:
      return { variant: "gray", label: status };
  }
}

interface StatusAction {
  label: string;
  toStatus: OrderStatus;
  style: "primary" | "secondary" | "warning" | "danger";
  icon: string;
  confirmMessage?: string;
}

function statusActions(current: string): StatusAction[] {
  switch (current) {
    case "DRAFT":
      return [
        {
          label: "Submit for review",
          toStatus: "PENDING",
          style: "primary",
          icon: "arrow-forward-circle-outline",
        },
      ];
    case "PENDING":
      return [
        {
          label: "Confirm order",
          toStatus: "CONFIRMED",
          style: "primary",
          icon: "checkmark-circle-outline",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order? It cannot be undone easily.",
        },
      ];
    case "CONFIRMED":
      return [
        {
          label: "Send for delivery",
          toStatus: "OUT_FOR_DELIVERY",
          style: "primary",
          icon: "car-outline",
        },
        {
          label: "Quick deliver",
          toStatus: "DELIVERED",
          style: "secondary",
          icon: "flash-outline",
          confirmMessage: "Mark as delivered without going through dispatch?",
        },
        {
          label: "Back to pending",
          toStatus: "PENDING",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert order back to Pending?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    case "OUT_FOR_DELIVERY":
      return [
        {
          label: "Mark delivered",
          toStatus: "DELIVERED",
          style: "primary",
          icon: "checkmark-done-circle-outline",
        },
        {
          label: "Partial delivery",
          toStatus: "PARTIALLY_DELIVERED",
          style: "secondary",
          icon: "git-branch-outline",
        },
        {
          label: "Back to confirmed",
          toStatus: "CONFIRMED",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert order back to Confirmed?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    case "PARTIALLY_DELIVERED":
      return [
        {
          label: "Mark fully delivered",
          toStatus: "DELIVERED",
          style: "primary",
          icon: "checkmark-done-circle-outline",
        },
        {
          label: "Back out for delivery",
          toStatus: "OUT_FOR_DELIVERY",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert back to Out for delivery?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    default:
      return [];
  }
}

export default function OrderDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading, isError, refetch } = useAdminOrder(id ?? "");
  const changeMut = useChangeOrderStatus();
  const deleteMut = useDeleteOrder();
  const urgentMut = useToggleOrderUrgent();

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Order" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Order" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <Text style={styles.notFoundTitle}>Order not found</Text>
          <Pressable onPress={() => router.back()} style={styles.notFoundBtn}>
            <Text style={styles.notFoundBtnText}>Back to orders</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const s = statusPill(order.status);
  const actions = statusActions(order.status);
  const canEdit = order.status === "PENDING" || order.status === "CONFIRMED";
  const isTerminal = order.status === "DELIVERED" || order.status === "CANCELLED";

  const handleStatusChange = (action: StatusAction) => {
    const doChange = () => {
      changeMut.mutate(
        { id: order.id, status: action.toStatus },
        {
          onSuccess: () => {
            showToast(`Order ${action.toStatus.toLowerCase().replace(/_/g, " ")}`);
            refetch();
          },
          onError: (e: unknown) => {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            showToast(err?.response?.data?.message ?? err?.message ?? "Try again.");
          },
        },
      );
    };

    if (action.confirmMessage) {
      confirm("Confirm action", action.confirmMessage, doChange, { confirmText: "Confirm" });
    } else {
      doChange();
    }
  };

  const handleDelete = () => {
    confirm(
      "Delete order?",
      "This permanently removes the order.",
      () =>
        deleteMut.mutate(order.id, {
          onSuccess: () => {
            showToast("Order deleted");
            router.back();
          },
          onError: (e: unknown) => {
            const err = e as { response?: { data?: { message?: string } }; message?: string };
            showToast(err?.response?.data?.message ?? err?.message ?? "Try again.");
          },
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  const handleToggleUrgent = () => {
    urgentMut.mutate(
      { id: order.id, urgent: !order.urgent },
      {
        onSuccess: () => {
          showToast(order.urgent ? "Urgent cleared" : "Marked urgent");
          refetch();
        },
        onError: (e: unknown) => {
          const err = e as { response?: { data?: { message?: string } }; message?: string };
          showToast(err?.response?.data?.message ?? err?.message ?? "Try again.");
        },
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={order.orderNumber}
        leading={
          <NavBackButton
            label="Orders"
            onPress={() => {
              // Always go to the orders list — `router.back()` would go to
              // wherever the user came from (e.g. /home), and after editing
              // an order they expect "Back to Orders" to mean the list, not
              // the deep link they originally followed.
              router.replace("/(operator)/(tabs)/orders" as any);
            }}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 14 }}>
          {/* Status + customer */}
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pill variant={s.variant} dot>
                {s.label}
              </Pill>
              {order.urgent ? <Pill variant="red">Urgent</Pill> : null}
            </View>
            <Text style={styles.customerName}>{order.customer?.businessName ?? "Customer"}</Text>
            {order.customer?.contactName || order.customer?.phone ? (
              <Text style={styles.customerSub}>
                {[order.customer?.contactName, order.customer?.phone].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            {order.requestedDeliveryDate ? (
              <Text style={styles.customerSub}>
                Requested {new Date(order.requestedDeliveryDate).toLocaleDateString()}
              </Text>
            ) : null}
            {order.deliveredAt ? (
              <Text style={styles.customerSub}>
                Delivered {new Date(order.deliveredAt).toLocaleDateString()}
              </Text>
            ) : null}
            {order.notes ? <Text style={styles.notes}>"{order.notes}"</Text> : null}
          </View>

          {/* Items */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Items</Text>
              {canEdit ? (
                <Pressable onPress={() => router.push(`/(operator)/orders/${order.id}/edit-items`)}>
                  <Text style={styles.linkText}>Edit</Text>
                </Pressable>
              ) : null}
            </View>
            {order.lineItems.length === 0 ? (
              <Text style={styles.empty}>No items on this order.</Text>
            ) : (
              order.lineItems.map((li, i) => {
                const upbRaw = (li as any).product?.unitsPerBox;
                const upb = upbRaw == null ? 0 : Number(upbRaw);
                const isBoxed = upb > 1;
                // Show "1 box + 2 pcs · $30 / box" when split, otherwise the
                // existing "8 ea · $5.00" form.
                const qtyLine = (() => {
                  if (li.boxes != null && li.boxes >= 0 && (li.boxes > 0 || (li.pieces ?? 0) > 0)) {
                    const parts: string[] = [];
                    if (li.boxes > 0) parts.push(`${li.boxes} box${li.boxes === 1 ? "" : "es"}`);
                    if ((li.pieces ?? 0) > 0)
                      parts.push(`${li.pieces} ${li.product?.unit ?? "pcs"}`);
                    return parts.join(" + ");
                  }
                  return `${li.qty} ${li.product?.unit ?? "ea"}`;
                })();
                return (
                  <View
                    key={li.id}
                    style={[
                      styles.itemRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: ios.separator,
                      },
                    ]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.itemName} numberOfLines={1}>
                        {li.product?.name ?? "Item"}
                      </Text>
                      <Text style={styles.itemSub}>
                        {qtyLine} · {formatCurrency(li.unitPrice)}
                        {isBoxed ? ` / box of ${upb}` : ""}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      <Text style={styles.itemTotal}>{formatCurrency(li.subtotal)}</Text>
                      {li.status && li.status !== "PENDING" ? (
                        <Pill
                          variant={
                            li.status === "DELIVERED"
                              ? "green"
                              : li.status === "PARTIAL"
                                ? "orange"
                                : "gray"
                          }
                          small
                          dot={false}
                        >
                          {li.status.toLowerCase()}
                        </Pill>
                      ) : null}
                    </View>
                  </View>
                );
              })
            )}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>{formatCurrency(order.subtotal)}</Text>
            </View>
            {order.tax ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Tax</Text>
                <Text style={styles.totalValue}>{formatCurrency(order.tax)}</Text>
              </View>
            ) : null}
            <View style={[styles.totalRow, styles.totalRowMain]}>
              <Text style={styles.totalLabelMain}>Total</Text>
              <Text style={styles.totalValueMain}>{formatCurrency(order.total)}</Text>
            </View>
          </View>

          {/* Status transitions */}
          {actions.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Status</Text>
              <View style={styles.actionsCol}>
                {actions.map((action) => (
                  <Pressable
                    key={action.toStatus}
                    style={[
                      styles.actionBtn,
                      action.style === "primary" && styles.primaryAction,
                      action.style === "secondary" && styles.secondaryAction,
                      action.style === "warning" && styles.warningAction,
                      action.style === "danger" && styles.dangerAction,
                      changeMut.isPending && styles.actionDisabled,
                    ]}
                    onPress={() => handleStatusChange(action)}
                    disabled={changeMut.isPending}
                  >
                    <Ionicons
                      name={action.icon as "checkmark-circle-outline"}
                      size={18}
                      color={
                        action.style === "primary"
                          ? "#fff"
                          : action.style === "danger"
                            ? ios.system.red
                            : action.style === "warning"
                              ? ios.system.orange
                              : ios.brand
                      }
                    />
                    <Text
                      style={[
                        styles.actionBtnText,
                        action.style === "primary" && { color: "#fff" },
                        action.style === "danger" && { color: ios.system.red },
                        action.style === "warning" && { color: ios.system.orange },
                      ]}
                    >
                      {action.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {/* Other actions */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>More</Text>
            <View style={styles.actionsCol}>
              {/* Split into multiple invoices — available once the order has items
                  and isn't a draft / cancelled. The screen prevents over-invoicing via
                  OrderItem.invoicedQty. */}
              {order.status !== "DRAFT" &&
              order.status !== "CANCELLED" &&
              (order.lineItems?.length ?? 0) > 0 ? (
                <Pressable
                  style={[styles.actionBtn, styles.secondaryAction]}
                  onPress={() => router.push(`/(operator)/orders/${order.id}/split-invoice`)}
                >
                  <Ionicons name="document-outline" size={18} color={ios.brand} />
                  <Text style={styles.actionBtnText}>Split into invoice…</Text>
                </Pressable>
              ) : null}
              {!isTerminal ? (
                <Pressable
                  style={[styles.actionBtn, styles.secondaryAction]}
                  onPress={handleToggleUrgent}
                  disabled={urgentMut.isPending}
                >
                  <Ionicons
                    name={order.urgent ? "flame" : "flame-outline"}
                    size={18}
                    color={ios.system.red}
                  />
                  <Text style={styles.actionBtnText}>
                    {order.urgent ? "Clear urgent flag" : "Mark as urgent"}
                  </Text>
                </Pressable>
              ) : null}
              {order.customer?.id ? (
                <Pressable
                  style={[styles.actionBtn, styles.secondaryAction]}
                  onPress={() => router.push(`/(operator)/customers/${order.customer!.id}`)}
                >
                  <Ionicons name="person-outline" size={18} color={ios.brand} />
                  <Text style={styles.actionBtnText}>View customer</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={[styles.actionBtn, styles.dangerAction]}
                onPress={handleDelete}
                disabled={deleteMut.isPending}
              >
                <Ionicons name="trash-outline" size={18} color={ios.system.red} />
                <Text style={[styles.actionBtnText, { color: ios.system.red }]}>Delete order</Text>
              </Pressable>
            </View>
          </View>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  notFoundTitle: { fontSize: 17, color: ios.label, marginBottom: 16 },
  notFoundBtn: { paddingVertical: 10, paddingHorizontal: 20 },
  notFoundBtnText: { color: ios.brand, fontSize: 15 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  customerName: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, marginTop: 4 },
  customerSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  notes: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 6,
    fontStyle: "italic",
  },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 8 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  totalRowMain: { paddingTop: 8, borderTopWidth: 0, marginTop: 0 },
  totalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  totalValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalLabelMain: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label },
  totalValueMain: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  actionsCol: { gap: 8 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  primaryAction: { backgroundColor: ios.brand },
  secondaryAction: { backgroundColor: ios.fill3 },
  warningAction: { backgroundColor: ios.fill3 },
  dangerAction: { backgroundColor: ios.fill3 },
  actionBtnText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  actionDisabled: { opacity: 0.5 },
});
