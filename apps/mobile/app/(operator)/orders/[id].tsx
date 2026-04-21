import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useAdminOrder } from "../../../lib/api/admin";
import {
  useCancelOrder,
  useConfirmOrder,
  useDeleteOrder,
  useToggleOrderUrgent,
} from "../../../lib/api/orders";
import { showToast } from "../../../lib/toast";

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function statusPill(status: string): { variant: "brand" | "green" | "orange" | "red" | "gray"; label: string } {
  switch (status) {
    case "PENDING":
      return { variant: "orange", label: "Pending" };
    case "CONFIRMED":
      return { variant: "brand", label: "Confirmed" };
    case "OUT_FOR_DELIVERY":
      return { variant: "brand", label: "Out for delivery" };
    case "DELIVERED":
      return { variant: "green", label: "Delivered" };
    case "CANCELLED":
      return { variant: "red", label: "Cancelled" };
    default:
      return { variant: "gray", label: status };
  }
}

export default function OrderDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading, refetch } = useAdminOrder(id ?? "");
  const confirmMut = useConfirmOrder();
  const cancelMut = useCancelOrder();
  const deleteMut = useDeleteOrder();
  const urgentMut = useToggleOrderUrgent();

  if (isLoading || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Order" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = statusPill(order.status);
  const canConfirm = order.status === "PENDING";
  const canCancel = order.status === "PENDING" || order.status === "CONFIRMED";
  const canEdit = order.status === "PENDING" || order.status === "CONFIRMED";

  const handleConfirm = () => {
    confirmMut.mutate(order.id, {
      onSuccess: () => {
        showToast("Order confirmed");
        refetch();
      },
      onError: (e: any) =>
        Alert.alert("Couldn't confirm", e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  const handleCancel = () => {
    Alert.alert("Cancel order?", `${order.orderNumber} will be marked as cancelled.`, [
      { text: "Keep it", style: "cancel" },
      {
        text: "Cancel order",
        style: "destructive",
        onPress: () =>
          cancelMut.mutate(order.id, {
            onSuccess: () => {
              showToast("Order cancelled");
              refetch();
            },
            onError: (e: any) =>
              Alert.alert("Couldn't cancel", e?.response?.data?.message ?? e?.message ?? "Try again."),
          }),
      },
    ]);
  };

  const handleDelete = () => {
    Alert.alert("Delete order?", "This permanently removes the order.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteMut.mutate(order.id, {
            onSuccess: () => {
              showToast("Order deleted");
              router.back();
            },
            onError: (e: any) =>
              Alert.alert("Couldn't delete", e?.response?.data?.message ?? e?.message ?? "Try again."),
          }),
      },
    ]);
  };

  const handleToggleUrgent = () => {
    urgentMut.mutate(
      { id: order.id, urgent: !order.urgent },
      {
        onSuccess: () => {
          showToast(order.urgent ? "Urgent cleared" : "Marked urgent");
          refetch();
        },
        onError: (e: any) =>
          Alert.alert("Couldn't update", e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={order.orderNumber}
        leading={<NavBackButton label="Orders" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 14 }}>
          {/* Status + urgent */}
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pill variant={s.variant} dot>
                {s.label}
              </Pill>
              {order.urgent ? <Pill variant="red">Urgent</Pill> : null}
            </View>
            <Text style={styles.customerName}>
              {order.customer?.businessName ?? "Customer"}
            </Text>
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
            {order.notes ? (
              <Text style={styles.notes}>“{order.notes}”</Text>
            ) : null}
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
              order.lineItems.map((li, i) => (
                <View
                  key={li.id}
                  style={[
                    styles.itemRow,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {li.product?.name ?? "Item"}
                    </Text>
                    <Text style={styles.itemSub}>
                      {li.qty} {li.product?.unit ?? "ea"} · {formatCurrency(li.unitPrice)}
                    </Text>
                  </View>
                  <Text style={styles.itemTotal}>{formatCurrency(li.subtotal)}</Text>
                </View>
              ))
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

          {/* Actions */}
          <View style={styles.actionsCol}>
            {canConfirm ? (
              <Pressable
                style={[styles.actionBtn, styles.primaryAction, confirmMut.isPending && styles.actionDisabled]}
                onPress={handleConfirm}
                disabled={confirmMut.isPending}
              >
                <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                <Text style={styles.primaryActionText}>
                  {confirmMut.isPending ? "Confirming…" : "Confirm order"}
                </Text>
              </Pressable>
            ) : null}

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
              <Text style={styles.secondaryActionText}>
                {order.urgent ? "Clear urgent" : "Mark urgent"}
              </Text>
            </Pressable>

            {canCancel ? (
              <Pressable
                style={[styles.actionBtn, styles.secondaryAction]}
                onPress={handleCancel}
                disabled={cancelMut.isPending}
              >
                <Ionicons name="close-circle-outline" size={18} color={ios.system.red} />
                <Text style={[styles.secondaryActionText, { color: ios.system.red }]}>
                  Cancel order
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              style={[styles.actionBtn, styles.secondaryAction]}
              onPress={handleDelete}
              disabled={deleteMut.isPending}
            >
              <Ionicons name="trash-outline" size={18} color={ios.system.red} />
              <Text style={[styles.secondaryActionText, { color: ios.system.red }]}>
                Delete order
              </Text>
            </Pressable>
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
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 6 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  customerName: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, marginTop: 6 },
  customerSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  notes: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 6,
    fontStyle: "italic",
  },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 12 },
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
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  totalRowMain: { paddingTop: 10, borderTopWidth: 0, marginTop: 0 },
  totalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  totalValue: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label, fontVariant: ["tabular-nums"] },
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
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
  primaryAction: { backgroundColor: ios.brand },
  primaryActionText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  secondaryAction: { backgroundColor: ios.bgElev },
  secondaryActionText: { color: ios.label, fontSize: 15, fontFamily: "Inter_500Medium" },
  actionDisabled: { opacity: 0.5 },
});
