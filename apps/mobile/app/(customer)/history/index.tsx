import { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
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

type FilterKey = "ALL" | "PENDING" | "ACTIVE" | "DELIVERED" | "CANCELLED";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "ALL",       label: "All" },
  { key: "PENDING",   label: "Pending" },
  { key: "ACTIVE",    label: "Active" },
  { key: "DELIVERED", label: "Delivered" },
  { key: "CANCELLED", label: "Cancelled" },
];

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

function matchesFilter(order: Order, filter: FilterKey): boolean {
  if (filter === "ALL") return true;
  if (filter === "PENDING") return order.status === "PENDING";
  if (filter === "ACTIVE") return order.status === "CONFIRMED" || order.status === "OUT_FOR_DELIVERY";
  if (filter === "DELIVERED") return order.status === "DELIVERED";
  if (filter === "CANCELLED") return order.status === "CANCELLED";
  return true;
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
  const [activeFilter, setActiveFilter] = useState<FilterKey>("ALL");

  const allOrders = data?.data ?? [];

  const filtered = useMemo(
    () => allOrders.filter((o) => matchesFilter(o, activeFilter)),
    [allOrders, activeFilter],
  );

  const sections: Section[] = useMemo(() => {
    const groups = new Map<string, Order[]>();
    for (const order of [...filtered].sort(
      (a, b) => parseISO(b.createdAt).getTime() - parseISO(a.createdAt).getTime(),
    )) {
      const key = format(parseISO(order.createdAt), "MMMM d, yyyy");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(order);
    }
    return Array.from(groups.entries()).map(([title, data]) => ({ title, data }));
  }, [filtered]);

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
      <View style={styles.container}>
        {/* Filter tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterBar}
          contentContainerStyle={styles.filterContent}
        >
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              style={[styles.filterChip, activeFilter === f.key && styles.filterChipActive]}
              onPress={() => setActiveFilter(f.key)}
            >
              <Text style={[styles.filterChipText, activeFilter === f.key && styles.filterChipTextActive]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

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
              <Text style={styles.emptyText}>
                {activeFilter === "ALL" ? "No past orders yet." : `No ${activeFilter.toLowerCase()} orders.`}
              </Text>
            </View>
          }
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  filterBar: {
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    flexGrow: 0,
  },
  filterContent: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  filterChipActive: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  filterChipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
  },
  filterChipTextActive: { color: colors.brand[500] },
  list: { backgroundColor: colors.surface.raised },
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
  rowLeft: { flex: 1, gap: 5 },
  orderId: { fontSize: 15, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  orderMeta: { fontSize: 13, fontFamily: "Inter_400Regular", color: "#64748b" },
  rowRight: { alignItems: "flex-end", gap: 4 },
  total: { fontSize: 16, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT },
  chevron: { fontSize: 20, color: "#94a3b8", lineHeight: 24 },
  empty: { alignItems: "center", paddingTop: 64 },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#94a3b8" },
});
