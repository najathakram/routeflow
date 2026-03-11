import { useMemo } from "react";
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from "react-native";
import { router, Stack } from "expo-router";
import { format, parseISO } from "date-fns";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { HistorySkeleton } from "../../../components/skeletons/HistorySkeleton";
import { NetworkError } from "../../../components/NetworkError";
import { useMyOrders, type Order } from "../../../lib/api/orders";

type Section = { title: string; data: Order[] };

function statusForBadge(
  status: Order["status"],
): "DELIVERED" | "IN_PROGRESS" | "PENDING" | "CANCELLED" {
  if (status === "OUT_FOR_DELIVERY") return "IN_PROGRESS";
  if (status === "CONFIRMED") return "IN_PROGRESS";
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "CANCELLED") return "CANCELLED";
  return "PENDING";
}

function OrderRow({ order }: { order: Order }) {
  const date = parseISO(order.createdAt);
  const timeLabel = format(date, "h:mm a");
  const itemCount = order.lineItems.reduce((s, i) => s + i.qty, 0);

  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push(`/(customer)/history/${order.id}`)}
    >
      <View style={styles.rowLeft}>
        <Text style={styles.orderId}>{order.orderNumber}</Text>
        <Text style={styles.orderMeta}>
          {itemCount} item{itemCount !== 1 ? "s" : ""} · {timeLabel}
        </Text>
        <StatusBadge status={statusForBadge(order.status)} />
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.total}>${Number(order.total).toFixed(2)}</Text>
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

export default function HistoryScreen() {
  const { data, isLoading, isError, refetch } = useMyOrders();

  const orders = data?.data ?? [];

  const sections: Section[] = useMemo(() => {
    const groups = new Map<string, Order[]>();
    for (const order of [...orders].sort(
      (a, b) => parseISO(b.createdAt).getTime() - parseISO(a.createdAt).getTime(),
    )) {
      const key = format(parseISO(order.createdAt), "MMMM d, yyyy");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(order);
    }
    return Array.from(groups.entries()).map(([title, data]) => ({ title, data }));
  }, [orders]);

  if (isLoading) return <><Stack.Screen options={{ title: "History" }} /><HistorySkeleton /></>;
  if (isError) return (
    <>
      <Stack.Screen options={{ title: "History" }} />
      <NetworkError onRetry={() => refetch()} />
    </>
  );

  return (
    <>
      <Stack.Screen options={{ title: "History" }} />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.content}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section: { title } }) => (
          <Text style={styles.sectionHeader}>{title}</Text>
        )}
        renderItem={({ item }) => <OrderRow order={item} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No past orders yet.</Text>
          </View>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: {
    backgroundColor: colors.surface.raised,
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    paddingBottom: 32,
    gap: 4,
  },
  sectionHeader: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 16,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    marginBottom: 8,
    ...shadows.card,
  },
  rowLeft: {
    flex: 1,
    gap: 5,
  },
  orderId: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  orderMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  rowRight: {
    alignItems: "flex-end",
    gap: 4,
  },
  total: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  chevron: {
    fontSize: 20,
    color: "#94a3b8",
    lineHeight: 24,
  },
  empty: {
    alignItems: "center",
    paddingTop: 64,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
