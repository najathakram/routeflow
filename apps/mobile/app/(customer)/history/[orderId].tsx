import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useOrder, useCancelOrder, useOrderTracking, type OrderItem } from "../../../lib/api/orders";
import { useOrderStore } from "../../../store/orderStore";

type ItemStatusBadge = "DELIVERED" | "CANCELLED" | "PENDING";

function itemStatusForBadge(status: string): ItemStatusBadge {
  if (status === "DELIVERED" || status === "PARTIAL") return "DELIVERED";
  if (status === "CANCELLED") return "CANCELLED";
  return "PENDING";
}

export default function OrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { data: order, isLoading, isError } = useOrder(orderId ?? "");
  const { data: trackingData } = useOrderTracking(orderId ?? "", order?.status);
  const addItem = useOrderStore((s) => s.addItem);
  const items = useOrderStore((s) => s.items);
  const loadItems = useOrderStore((s) => s.loadItems);
  const setEditingOrderId = useOrderStore((s) => s.setEditingOrderId);
  const { mutate: cancelOrder, isPending: isCancelling } = useCancelOrder();

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
              onError: (err) =>
                Alert.alert("Could not cancel", err.message || "Please try again."),
            }),
        },
      ],
    );
  };

  const handleReorder = () => {
    if (!order) return;
    const alreadyInCart = items.length > 0;
    const doReorder = () => {
      for (const line of order.lineItems) {
        if (!line.product) continue;
        addItem(
          {
            id: line.productId,
            name: line.product.name,
            unit: line.product.unit,
            pricePerUnit: Number(line.unitPrice),
          },
          line.qty,
        );
      }
      router.push("/(customer)/order");
    };

    if (alreadyInCart) {
      Alert.alert(
        "Add to existing order?",
        "You already have items in your order. These items will be added to it.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Add Items", onPress: doReorder },
        ],
      );
    } else {
      doReorder();
    }
  };

  const handleEditOrder = () => {
    if (!order) return;
    const mapped = order.lineItems
      .filter((l) => l.product)
      .map((l) => ({
        productId: l.productId,
        name: l.product!.name,
        unitPrice: Number(l.unitPrice),
        unit: l.product!.unit,
        quantity: l.qty,
      }));
    loadItems(mapped);
    setEditingOrderId(order.id);
    router.push("/(customer)/order");
  };

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Order", headerBackTitle: "History" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError || !order) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Order not found.</Text>
      </View>
    );
  }

  const date = parseISO(order.createdAt);
  const deliveryDate = format(date, "EEEE, MMMM d, yyyy");
  const deliveryTime = format(date, "h:mm a");
  const itemCount = order.lineItems.reduce((s, i) => s + i.qty, 0);

  return (
    <>
      <Stack.Screen
        options={{
          title: order.orderNumber,
          headerBackTitle: "History",
          headerRight: () => (
            <Pressable
              onPress={handleReorder}
              style={{ paddingRight: 4 }}
              accessibilityRole="button"
              accessibilityLabel="Reorder"
            >
              <Text style={{ color: colors.brand[500], fontFamily: "Inter_600SemiBold", fontSize: 15 }}>
                Reorder
              </Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Tracking Banner — shown when OUT_FOR_DELIVERY */}
        {order.status === "OUT_FOR_DELIVERY" && trackingData?.tracking && (
          <View style={styles.trackingCard}>
            <View style={styles.trackingHeader}>
              <Ionicons name="navigate" size={18} color={colors.brand[500]} />
              <Text style={styles.trackingTitle}>Your delivery is on the way!</Text>
            </View>
            {trackingData.tracking.driverName && (
              <Text style={styles.trackingDriver}>Driver: {trackingData.tracking.driverName}</Text>
            )}
            <Text style={styles.trackingStops}>
              {trackingData.tracking.stopsAhead === 0
                ? "🎉 Your stop is next!"
                : `${trackingData.tracking.stopsAhead} stop${trackingData.tracking.stopsAhead !== 1 ? "s" : ""} before yours`}
            </Text>
            <View style={styles.trackingProgress}>
              <View
                style={[
                  styles.trackingProgressFill,
                  {
                    width: trackingData.tracking.stopsAhead === 0
                      ? "100%"
                      : `${Math.max(10, 100 - trackingData.tracking.stopsAhead * 15)}%`,
                  },
                ]}
              />
            </View>
          </View>
        )}

        {/* Order summary card */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Order #</Text>
            <Text style={styles.summaryValue}>{order.orderNumber}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Status</Text>
            <StatusBadge status={order.status === "OUT_FOR_DELIVERY" ? "IN_PROGRESS" : order.status === "CONFIRMED" ? "IN_PROGRESS" : order.status === "DELIVERED" ? "DELIVERED" : order.status === "CANCELLED" ? "CANCELLED" : "PENDING"} />
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Date</Text>
            <Text style={styles.summaryValue}>{deliveryDate}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Time</Text>
            <Text style={styles.summaryValue}>{deliveryTime}</Text>
          </View>
          <View style={[styles.summaryRow, styles.summaryLast]}>
            <Text style={styles.summaryLabel}>Items</Text>
            <Text style={styles.summaryValue}>{itemCount}</Text>
          </View>
        </View>

        {/* Line items */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Items</Text>
          {order.lineItems.map((item, idx) => (
            <View
              key={item.id}
              style={[
                styles.lineItem,
                idx === order.lineItems.length - 1 && styles.lineItemLast,
              ]}
            >
              <View style={styles.lineLeft}>
                <Text style={styles.itemName}>{item.product?.name ?? item.productId}</Text>
                <Text style={styles.itemQty}>
                  {item.qty} × ${Number(item.unitPrice).toFixed(2)}
                </Text>
              </View>
              <View style={styles.lineRight}>
                <Text style={styles.itemTotal}>
                  ${(item.qty * Number(item.unitPrice)).toFixed(2)}
                </Text>
                <StatusBadge status={itemStatusForBadge(item.status)} />
              </View>
            </View>
          ))}
        </View>

        {/* Notes */}
        {order.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Order Notes</Text>
            <View style={styles.noteBox}>
              <Ionicons
                name="chatbox-ellipses-outline"
                size={18}
                color={colors.brand[500]}
                style={styles.noteIcon}
              />
              <Text style={styles.noteText}>{order.notes}</Text>
            </View>
          </View>
        ) : null}

        {/* Driver note */}
        {order.driverNote ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Driver Note</Text>
            <View style={[styles.noteBox, styles.driverNoteBox]}>
              <Ionicons
                name="person-outline"
                size={18}
                color="#64748b"
                style={styles.noteIcon}
              />
              <Text style={[styles.noteText, styles.driverNoteText]}>{order.driverNote}</Text>
            </View>
          </View>
        ) : null}

        {/* Total */}
        <View style={[styles.section, styles.totalSection]}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Order Total</Text>
            <Text style={styles.totalValue}>${Number(order.total).toFixed(2)}</Text>
          </View>
        </View>

        {/* Return CTA — only for delivered orders */}
        {order.status === "DELIVERED" && (
          <Pressable
            style={styles.returnBtn}
            onPress={() =>
              router.push(
                `/(customer)/returns/new?orderId=${order.id}` as any,
              )
            }
            accessibilityRole="button"
          >
            <Ionicons name="return-down-back-outline" size={18} color={colors.danger.DEFAULT} />
            <Text style={styles.returnBtnText}>Request a Return</Text>
          </Pressable>
        )}

        {/* Edit / Cancel CTAs — only for pending orders */}
        {order.status === "PENDING" && (
          <>
            <Pressable
              style={styles.editOrderBtn}
              onPress={handleEditOrder}
              accessibilityRole="button"
            >
              <Ionicons name="create-outline" size={18} color={colors.brand[500]} />
              <Text style={styles.editOrderBtnText}>Edit Order</Text>
            </Pressable>
            <Pressable
              style={[styles.returnBtn, isCancelling && styles.btnDisabled]}
              onPress={handleCancel}
              disabled={isCancelling}
              accessibilityRole="button"
            >
              <Ionicons name="close-circle-outline" size={18} color={colors.danger.DEFAULT} />
              <Text style={styles.returnBtnText}>
                {isCancelling ? "Cancelling…" : "Cancel Order"}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    paddingBottom: 32,
    gap: 12,
  },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  notFoundText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  trackingCard: {
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.brand[200] ?? colors.brand[500] + "33",
    ...shadows.card,
  },
  trackingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  trackingTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.brand[600] ?? colors.brand[500],
  },
  trackingDriver: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  trackingStops: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  trackingProgress: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surface.border,
    overflow: "hidden",
  },
  trackingProgressFill: {
    height: "100%",
    backgroundColor: colors.brand[500],
    borderRadius: 3,
  },
  summaryCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 4,
    ...shadows.card,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  summaryLast: {
    borderBottomWidth: 0,
  },
  summaryLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  summaryValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    textAlign: "right",
    flex: 1,
    paddingLeft: 12,
  },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingHorizontal: 16,
    paddingVertical: 16,
    ...shadows.card,
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
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  lineItemLast: {
    borderBottomWidth: 0,
  },
  lineLeft: {
    flex: 1,
    paddingRight: 12,
  },
  itemName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    marginBottom: 2,
  },
  itemQty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  lineRight: {
    alignItems: "flex-end",
    gap: 6,
  },
  itemTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  noteBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    gap: 10,
  },
  driverNoteBox: {
    backgroundColor: "#f1f5f9",
  },
  noteIcon: {
    marginTop: 1,
  },
  noteText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    lineHeight: 20,
  },
  driverNoteText: {
    color: "#475569",
  },
  btnDisabled: {
    opacity: 0.6,
  },
  totalSection: {
    ...shadows.card,
  },
  editOrderBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.lg,
    padding: 14,
    borderWidth: 1.5,
    borderColor: colors.brand[500],
    ...shadows.card,
  },
  editOrderBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  returnBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.danger.bg,
    borderRadius: borderRadius.lg,
    padding: 14,
    borderWidth: 1.5,
    borderColor: colors.danger.DEFAULT,
    ...shadows.card,
  },
  returnBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.danger.DEFAULT,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  totalLabel: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  totalValue: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.brand[700],
  },
});
