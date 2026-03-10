import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { MOCK_HISTORY, HistoryOrderItem } from "../../../data/mockData";

function itemStatusForBadge(
  status: HistoryOrderItem["status"],
): "DELIVERED" | "CANCELLED" | "PENDING" {
  return status;
}

export default function OrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const order = MOCK_HISTORY.find((o) => o.id === orderId);

  if (!order) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Order not found.</Text>
      </View>
    );
  }

  const date = parseISO(order.date);
  const deliveryDate = format(date, "EEEE, MMMM d, yyyy");
  const deliveryTime = format(date, "h:mm a");
  const itemCount = order.items.reduce((s, i) => s + i.qty, 0);

  return (
    <>
      <Stack.Screen
        options={{
          title: order.id,
          headerBackTitle: "History",
        }}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Order summary card */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Order ID</Text>
            <Text style={styles.summaryValue}>{order.id}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Status</Text>
            <StatusBadge status={order.status === "IN_TRANSIT" ? "IN_PROGRESS" : order.status} />
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Delivery Date</Text>
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
          {order.items.map((item, idx) => (
            <View
              key={idx}
              style={[
                styles.lineItem,
                idx === order.items.length - 1 && styles.lineItemLast,
              ]}
            >
              <View style={styles.lineLeft}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemQty}>
                  {item.qty} × ${item.unitPrice.toFixed(2)}
                </Text>
              </View>
              <View style={styles.lineRight}>
                <Text style={styles.itemTotal}>
                  ${(item.qty * item.unitPrice).toFixed(2)}
                </Text>
                <StatusBadge status={itemStatusForBadge(item.status)} />
              </View>
            </View>
          ))}
        </View>

        {/* Driver note */}
        {order.driverNote ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Driver Note</Text>
            <View style={styles.driverNoteBox}>
              <Ionicons
                name="chatbox-ellipses-outline"
                size={18}
                color={colors.brand[500]}
                style={styles.driverNoteIcon}
              />
              <Text style={styles.driverNoteText}>{order.driverNote}</Text>
            </View>
          </View>
        ) : null}

        {/* Total */}
        <View style={[styles.section, styles.totalSection]}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Order Total</Text>
            <Text style={styles.totalValue}>${order.total.toFixed(2)}</Text>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
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
  driverNoteBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    gap: 10,
  },
  driverNoteIcon: {
    marginTop: 1,
  },
  driverNoteText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    lineHeight: 20,
  },
  totalSection: {
    ...shadows.card,
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
