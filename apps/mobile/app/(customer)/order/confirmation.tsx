import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useOrder } from "../../../lib/api/orders";

export default function OrderConfirmationScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { data: order, isLoading } = useOrder(orderId ?? "");

  return (
    <>
      <Stack.Screen
        options={{ title: "Order Confirmed", headerBackVisible: false }}
      />
      <View style={styles.container}>
        {isLoading || !order ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.brand[500]} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            {/* Success icon */}
            <View style={styles.successCard}>
              <View style={styles.iconCircle}>
                <Ionicons
                  name="checkmark-circle"
                  size={64}
                  color={colors.success.DEFAULT}
                />
              </View>
              <Text style={styles.successTitle}>Order Placed!</Text>
              <Text style={styles.successSubtitle}>
                Your order has been received and is being processed.
              </Text>
            </View>

            {/* Order summary */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Order Details</Text>

              <View style={styles.row}>
                <Text style={styles.rowLabel}>Order #</Text>
                <Text style={styles.rowValue}>{order.orderNumber}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Status</Text>
                <StatusBadge status="PENDING" />
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Placed</Text>
                <Text style={styles.rowValue}>
                  {format(parseISO(order.createdAt), "EEE, MMM d · h:mm a")}
                </Text>
              </View>
              {order.urgent && (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Priority</Text>
                  <View style={styles.urgentChip}>
                    <Ionicons name="flash" size={13} color={colors.danger.DEFAULT} />
                    <Text style={styles.urgentChipText}>Urgent</Text>
                  </View>
                </View>
              )}
              <View style={[styles.row, styles.rowLast]}>
                <Text style={styles.rowLabel}>Total</Text>
                <Text style={styles.rowValueBold}>${Number(order.total).toFixed(2)}</Text>
              </View>
            </View>

            {/* Items */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                Items ({order.lineItems.reduce((s, i) => s + i.qty, 0)})
              </Text>
              {order.lineItems.map((item, idx) => (
                <View
                  key={item.id}
                  style={[
                    styles.lineItem,
                    idx === order.lineItems.length - 1 && styles.lineItemLast,
                  ]}
                >
                  <Text style={styles.itemName}>
                    {item.product?.name ?? item.productId}
                  </Text>
                  <Text style={styles.itemQty}>
                    {item.qty} × ${Number(item.unitPrice).toFixed(2)}
                  </Text>
                  <Text style={styles.itemTotal}>
                    ${(item.qty * Number(item.unitPrice)).toFixed(2)}
                  </Text>
                </View>
              ))}
            </View>

            {order.notes ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Notes</Text>
                <Text style={styles.notes}>{order.notes}</Text>
              </View>
            ) : null}
          </ScrollView>
        )}

        {/* Footer actions */}
        <View style={styles.footer}>
          <Pressable
            style={styles.historyBtn}
            onPress={() => router.replace("/(customer)/history")}
            accessibilityRole="button"
          >
            <Ionicons name="time-outline" size={18} color={colors.navy.DEFAULT} style={{ marginRight: 6 }} />
            <Text style={styles.historyBtnText}>View Order History</Text>
          </Pressable>
          <Pressable
            style={styles.shopBtn}
            onPress={() => router.replace("/(customer)/shop")}
            accessibilityRole="button"
          >
            <Ionicons name="bag-outline" size={18} color="#fff" style={{ marginRight: 6 }} />
            <Text style={styles.shopBtnText}>Continue Shopping</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 32,
    gap: 12,
  },
  successCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 24,
    alignItems: "center",
    gap: 10,
    ...shadows.card,
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.success.bg,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  successTitle: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  successSubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    textAlign: "center",
    lineHeight: 20,
  },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 4,
    ...shadows.card,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingTop: 14,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  rowValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  rowValueBold: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.brand[700],
  },
  urgentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.danger.bg,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  urgentChipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.danger.DEFAULT,
  },
  lineItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    gap: 8,
  },
  lineItemLast: { borderBottomWidth: 0 },
  itemName: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  itemQty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    minWidth: 60,
    textAlign: "right",
  },
  notes: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    lineHeight: 20,
    paddingVertical: 12,
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 10,
  },
  historyBtn: {
    height: 48,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  historyBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  shopBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  shopBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
