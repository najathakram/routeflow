import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import {
  useAdminOrder,
  useConfirmAdminOrder,
  useCancelAdminOrder,
} from "../../../lib/api/admin";

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fef3c7", text: "#92400e" },
  CONFIRMED: { bg: "#dbeafe", text: "#1e40af" },
  OUT_FOR_DELIVERY: { bg: "#ede9fe", text: "#5b21b6" },
  DELIVERED: { bg: "#d1fae5", text: "#065f46" },
  CANCELLED: { bg: "#f1f5f9", text: "#475569" },
};

export default function AdminOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: order, isLoading, isError, refetch } = useAdminOrder(id);
  const confirmOrder = useConfirmAdminOrder();
  const cancelOrder = useCancelAdminOrder();

  const handleConfirm = () => {
    Alert.alert("Confirm Order", "Mark this order as CONFIRMED?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Confirm",
        onPress: () =>
          confirmOrder.mutate(id, {
            onSuccess: () => refetch(),
            onError: () => Alert.alert("Error", "Failed to confirm order"),
          }),
      },
    ]);
  };

  const handleCancel = () => {
    Alert.alert("Cancel Order", "Are you sure you want to cancel this order?", [
      { text: "No", style: "cancel" },
      {
        text: "Yes, Cancel",
        style: "destructive",
        onPress: () =>
          cancelOrder.mutate(id, {
            onSuccess: () => refetch(),
            onError: () => Alert.alert("Error", "Failed to cancel order"),
          }),
      },
    ]);
  };

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#2563EB" />
      </View>
    );
  }

  if (isError || !order) {
    return (
      <View style={styles.centered}>
        <Ionicons name="cloud-offline-outline" size={40} color="#cbd5e1" />
        <Text style={styles.errorText}>Failed to load order</Text>
        <Pressable style={styles.retryBtn} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const sc = STATUS_COLORS[order.status] ?? { bg: "#f1f5f9", text: "#475569" };

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* Order header */}
      <View style={styles.card}>
        <View style={styles.orderHeaderRow}>
          <Text style={styles.orderNumber}>{order.orderNumber}</Text>
          <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.statusText, { color: sc.text }]}>
              {order.status}
            </Text>
          </View>
        </View>
        {order.urgent && (
          <View style={styles.urgentBanner}>
            <Ionicons name="flash" size={14} color="#dc2626" />
            <Text style={styles.urgentBannerText}>Urgent Order</Text>
          </View>
        )}
        <Text style={styles.metaText}>
          Created: {new Date(order.createdAt).toLocaleDateString()}
        </Text>
        {order.requestedDeliveryDate && (
          <Text style={styles.metaText}>
            Requested delivery:{" "}
            {new Date(order.requestedDeliveryDate).toLocaleDateString()}
          </Text>
        )}
        {order.deliveredAt && (
          <Text style={styles.metaText}>
            Delivered: {new Date(order.deliveredAt).toLocaleDateString()}
          </Text>
        )}
      </View>

      {/* Customer Info */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Customer</Text>
        <Text style={styles.customerName}>
          {order.customer?.businessName ?? "—"}
        </Text>
        {order.customer?.contactName && (
          <Text style={styles.metaText}>{order.customer.contactName}</Text>
        )}
        {order.customer?.phone && (
          <View style={styles.infoRow}>
            <Ionicons name="call-outline" size={14} color="#64748b" />
            <Text style={styles.metaText}>{order.customer.phone}</Text>
          </View>
        )}
      </View>

      {/* Line Items */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Items</Text>
        {order.lineItems.map((item, index) => (
          <View key={item.id} style={[styles.lineItem, index === 0 && { borderTopWidth: 0 }]}>
            <View style={styles.lineItemLeft}>
              <Text style={styles.productName}>
                {item.product?.name ?? item.productId}
              </Text>
              <Text style={styles.productUnit}>
                {item.qty} × ${Number(item.unitPrice).toFixed(2)}{" "}
                {item.product?.unit ? `/ ${item.product.unit}` : ""}
              </Text>
            </View>
            <Text style={styles.lineItemSubtotal}>
              ${Number(item.subtotal).toFixed(2)}
            </Text>
          </View>
        ))}
      </View>

      {/* Totals */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Order Totals</Text>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Subtotal</Text>
          <Text style={styles.totalValue}>${Number(order.subtotal).toFixed(2)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Tax</Text>
          <Text style={styles.totalValue}>${Number(order.tax).toFixed(2)}</Text>
        </View>
        <View style={[styles.totalRow, styles.totalFinalRow]}>
          <Text style={styles.totalFinalLabel}>Total</Text>
          <Text style={styles.totalFinalValue}>
            ${Number(order.total).toFixed(2)}
          </Text>
        </View>
      </View>

      {/* Notes */}
      {order.notes ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Notes</Text>
          <Text style={styles.notesText}>{order.notes}</Text>
        </View>
      ) : null}

      {/* Actions */}
      {(order.status === "PENDING" || order.status === "CONFIRMED") && (
        <View style={styles.actionsCard}>
          {order.status === "PENDING" && (
            <Pressable
              style={[styles.actionBtn, styles.confirmBtn]}
              onPress={handleConfirm}
              disabled={confirmOrder.isPending}
            >
              {confirmOrder.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                  <Text style={styles.actionBtnText}>Confirm Order</Text>
                </>
              )}
            </Pressable>
          )}
          <Pressable
            style={[styles.actionBtn, styles.cancelBtn]}
            onPress={handleCancel}
            disabled={cancelOrder.isPending}
          >
            {cancelOrder.isPending ? (
              <ActivityIndicator size="small" color="#dc2626" />
            ) : (
              <>
                <Ionicons name="close-circle-outline" size={18} color="#dc2626" />
                <Text style={[styles.actionBtnText, { color: "#dc2626" }]}>
                  Cancel Order
                </Text>
              </>
            )}
          </Pressable>
        </View>
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "#f8fafc",
  },
  errorText: { fontSize: 15, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "#2563EB",
    borderRadius: 8,
  },
  retryText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 14 },
  card: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  orderHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  orderNumber: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  statusText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  urgentBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
  },
  urgentBannerText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#dc2626",
  },
  metaText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  cardTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  customerName: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  lineItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  lineItemLeft: { flex: 1 },
  productName: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  productUnit: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  lineItemSubtotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  totalFinalRow: { borderTopWidth: 1, borderTopColor: "#e2e8f0", marginTop: 4 },
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
  totalFinalLabel: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  totalFinalValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  notesText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#475569",
    lineHeight: 20,
  },
  actionsCard: {
    marginHorizontal: 16,
    marginTop: 12,
    gap: 10,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 10,
  },
  confirmBtn: { backgroundColor: "#2563EB" },
  cancelBtn: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  actionBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
});
