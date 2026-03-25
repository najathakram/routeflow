import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyStandingOrders, type StandingOrder } from "../../../lib/api/standing-orders";
import { NetworkError } from "../../../components/NetworkError";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daySchedule(daysOfWeek: number[]): string {
  if (!daysOfWeek || daysOfWeek.length === 0) return "No schedule";
  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  return sorted.map((d) => DAY_LABELS[d]).join(", ");
}

function StandingOrderCard({ order }: { order: StandingOrder }) {
  const itemCount = order.items?.length ?? 0;
  const schedule = daySchedule(order.daysOfWeek);

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/(customer)/standing-orders/${order.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={order.name}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.orderName} numberOfLines={1}>{order.name}</Text>
          <View style={styles.scheduleRow}>
            <Ionicons name="repeat-outline" size={14} color="#94a3b8" />
            <Text style={styles.scheduleText}>{schedule}</Text>
          </View>
        </View>
        <View style={[styles.activeBadge, { backgroundColor: order.isActive ? colors.success.bg : colors.surface.raised }]}>
          <Text style={[styles.activeBadgeText, { color: order.isActive ? colors.success.DEFAULT : "#94a3b8" }]}>
            {order.isActive ? "Active" : "Paused"}
          </Text>
        </View>
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.stat}>
          <Ionicons name="cube-outline" size={15} color="#94a3b8" />
          <Text style={styles.statText}>
            {itemCount} product{itemCount !== 1 ? "s" : ""}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
      </View>
    </Pressable>
  );
}

export default function StandingOrdersScreen() {
  const { data, isLoading, isError, refetch } = useMyStandingOrders();

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Standing Orders" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Standing Orders" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const orders = data?.data ?? [];

  return (
    <>
      <Stack.Screen
        options={{
          title: "Standing Orders",
          headerRight: () => (
            <Pressable
              onPress={() => router.push("/(customer)/standing-orders/new" as any)}
              hitSlop={10}
              style={{ paddingRight: 4 }}
              accessibilityRole="button"
              accessibilityLabel="Create standing order"
            >
              <Ionicons name="add" size={26} color={colors.brand[500]} />
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={orders}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          orders.length > 0 ? (
            <Text style={styles.listHeader}>
              {orders.filter((o) => o.isActive).length} active · {orders.length} total
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="repeat-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyText}>No standing orders yet.</Text>
            <Text style={styles.emptySubtext}>
              Tap the + button to create your first recurring order.
            </Text>
            <Pressable
              style={styles.createBtn}
              onPress={() => router.push("/(customer)/standing-orders/new" as any)}
              accessibilityRole="button"
            >
              <Ionicons name="add-circle-outline" size={18} color="#fff" />
              <Text style={styles.createBtnText}>Create Standing Order</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => <StandingOrderCard order={item} />}
      />

      {/* FAB */}
      <Pressable
        style={styles.fab}
        onPress={() => router.push("/(customer)/standing-orders/new" as any)}
        accessibilityRole="button"
        accessibilityLabel="Create standing order"
      >
        <Ionicons name="add" size={28} color="#fff" />
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 100, // room for FAB
    gap: 10,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  listHeader: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  empty: {
    alignItems: "center",
    paddingTop: 64,
    paddingHorizontal: 32,
    gap: 10,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  emptySubtext: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#cbd5e1",
    textAlign: "center",
    lineHeight: 18,
  },
  createBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
  },
  createBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  cardLeft: { flex: 1, gap: 4, paddingRight: 12 },
  orderName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  scheduleText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  activeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  activeBadgeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  statText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  fab: {
    position: "absolute",
    bottom: 28,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
    ...shadows.card,
    elevation: 6,
  },
});
