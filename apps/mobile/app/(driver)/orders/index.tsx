import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyOrders, type Order } from "../../../lib/api/orders";
import { format } from "date-fns";

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  PENDING:           { label: "Pending",       bg: "#fef3c7", text: "#92400e" },
  CONFIRMED:         { label: "Confirmed",     bg: "#dbeafe", text: "#1e40af" },
  OUT_FOR_DELIVERY:  { label: "Out for Delivery", bg: "#ede9fe", text: "#5b21b6" },
  DELIVERED:         { label: "Delivered",     bg: "#d1fae5", text: "#065f46" },
  CANCELLED:         { label: "Cancelled",     bg: "#fee2e2", text: "#991b1b" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, bg: "#f1f5f9", text: "#64748b" };
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.badgeText, { color: cfg.text }]}>{cfg.label}</Text>
    </View>
  );
}

// ─── Order row ────────────────────────────────────────────────────────────────

function OrderRow({ order }: { order: Order }) {
  const itemCount = order.lineItems?.reduce((n, i) => n + i.qty, 0) ?? 0;
  const productCount = order.lineItems?.length ?? 0;
  const createdDate = format(new Date(order.createdAt), "MMM d");

  return (
    <Pressable
      style={styles.orderRow}
      onPress={() => router.push(`/(driver)/orders/${order.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`Order ${order.orderNumber}`}
    >
      <View style={styles.orderRowLeft}>
        <View style={styles.orderRowTop}>
          <Text style={styles.orderNumber}>#{order.orderNumber}</Text>
          <StatusBadge status={order.status} />
        </View>
        <Text style={styles.orderMeta}>
          {productCount} product{productCount !== 1 ? "s" : ""} · {itemCount} item{itemCount !== 1 ? "s" : ""} · {createdDate}
        </Text>
        {order.urgent && (
          <View style={styles.urgentTag}>
            <Ionicons name="flash" size={11} color="#b45309" />
            <Text style={styles.urgentTagText}>Urgent</Text>
          </View>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
    </Pressable>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function OrdersListScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const { data, isLoading, refetch } = useMyOrders({ limit: 100 });
  const allOrders: Order[] = data?.data ?? [];

  // Filter out completed/cancelled, show PENDING first then others
  const activeOrders = allOrders.filter(
    (o) => o.status !== "DELIVERED" && o.status !== "CANCELLED",
  );
  const pending = activeOrders.filter((o) => o.status === "PENDING");
  const others = activeOrders.filter((o) => o.status !== "PENDING");

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Orders",
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
          headerRight: () => (
            <Pressable
              onPress={() => router.push("/(driver)/orders/new")}
              style={{ paddingRight: 4, paddingLeft: 12, paddingVertical: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Create new order"
            >
              <Ionicons name="add" size={26} color={colors.brand[500]} />
            </Pressable>
          ),
        }}
      />

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.brand[500]} />
          </View>
        ) : activeOrders.length === 0 ? (
          <View style={styles.centered}>
            <Ionicons name="receipt-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyTitle}>No active orders</Text>
            <Text style={styles.emptySubtitle}>Orders will appear here when created</Text>
            <Pressable
              style={styles.newOrderBtn}
              onPress={() => router.push("/(driver)/orders/new")}
            >
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={styles.newOrderBtnText}>New Order</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {pending.length > 0 && (
              <View style={styles.group}>
                <Text style={styles.groupTitle}>PENDING CONFIRMATION</Text>
                {pending.map((o) => <OrderRow key={o.id} order={o} />)}
              </View>
            )}
            {others.length > 0 && (
              <View style={styles.group}>
                <Text style={styles.groupTitle}>OTHER ACTIVE</Text>
                {others.map((o) => <OrderRow key={o.id} order={o} />)}
              </View>
            )}
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
  scroll: {
    padding: 16,
    gap: 8,
    paddingBottom: 40,
  },
  centered: {
    paddingVertical: 80,
    alignItems: "center",
    gap: 10,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    marginTop: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#cbd5e1",
    textAlign: "center",
  },
  newOrderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand[500],
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: borderRadius.DEFAULT,
    marginTop: 8,
  },
  newOrderBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  group: {
    gap: 8,
    marginBottom: 8,
  },
  groupTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    paddingHorizontal: 4,
    marginBottom: 2,
  },
  orderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    ...shadows.card,
  },
  orderRowLeft: {
    flex: 1,
    gap: 4,
  },
  orderRowTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  orderNumber: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  orderMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  badgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  urgentTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#fef3c7",
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  urgentTagText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: "#b45309",
  },
});
