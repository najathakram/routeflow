import { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { format, parseISO } from "date-fns";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { HistorySkeleton } from "../../../components/skeletons/HistorySkeleton";
import { NetworkError } from "../../../components/NetworkError";
import { useMyOrders, type Order } from "../../../lib/api/orders";
import { useOrderStore } from "../../../store/orderStore";

// ─── Analytics ───────────────────────────────────────────────────────────────

interface Analytics {
  totalSpent: number;
  deliveredCount: number;
  totalCount: number;
  avgOrderValue: number;
  topProducts: { name: string; qty: number; pct: number }[];
}

function computeAnalytics(orders: Order[]): Analytics {
  const delivered = orders.filter((o) => o.status === "DELIVERED");
  const totalSpent = delivered.reduce((s, o) => s + Number(o.total), 0);
  const avgOrderValue = delivered.length ? totalSpent / delivered.length : 0;

  // Aggregate qty per product across all orders (not just delivered)
  const qtyMap = new Map<string, { name: string; qty: number }>();
  for (const order of orders) {
    for (const item of order.lineItems) {
      const name = item.product?.name ?? "Unknown";
      const prev = qtyMap.get(item.productId) ?? { name, qty: 0 };
      qtyMap.set(item.productId, { name, qty: prev.qty + Number(item.qty) });
    }
  }
  const sorted = Array.from(qtyMap.values()).sort((a, b) => b.qty - a.qty).slice(0, 5);
  const maxQty = sorted[0]?.qty ?? 1;
  const topProducts = sorted.map((p) => ({ ...p, pct: p.qty / maxQty }));

  return { totalSpent, deliveredCount: delivered.length, totalCount: orders.length, avgOrderValue, topProducts };
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={aStyles.kpiCard}>
      <Text style={aStyles.kpiValue}>{value}</Text>
      <Text style={aStyles.kpiLabel}>{label}</Text>
      {sub ? <Text style={aStyles.kpiSub}>{sub}</Text> : null}
    </View>
  );
}

function AnalyticsPanel({ orders }: { orders: Order[] }) {
  const stats = useMemo(() => computeAnalytics(orders), [orders]);
  if (orders.length === 0) return null;

  return (
    <View style={aStyles.panel}>
      {/* KPI row */}
      <Text style={aStyles.panelTitle}>Your Insights</Text>
      <View style={aStyles.kpiRow}>
        <KpiCard label="Total Spent" value={`$${stats.totalSpent.toFixed(2)}`} />
        <View style={aStyles.kpiDivider} />
        <KpiCard
          label="Avg Order"
          value={`$${stats.avgOrderValue.toFixed(2)}`}
          sub={`${stats.deliveredCount} delivered`}
        />
        <View style={aStyles.kpiDivider} />
        <KpiCard label="Orders" value={String(stats.totalCount)} sub="all time" />
      </View>

      {/* Top products */}
      {stats.topProducts.length > 0 && (
        <>
          <View style={aStyles.divider} />
          <Text style={aStyles.subTitle}>Top Products</Text>
          {stats.topProducts.map((p, i) => (
            <View key={p.name} style={aStyles.productRow}>
              <Text style={aStyles.productRank}>#{i + 1}</Text>
              <View style={aStyles.productCenter}>
                <Text style={aStyles.productName} numberOfLines={1}>{p.name}</Text>
                <View style={aStyles.barTrack}>
                  <View style={[aStyles.barFill, { width: `${Math.round(p.pct * 100)}%` }]} />
                </View>
              </View>
              <Text style={aStyles.productQty}>{p.qty} units</Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

const aStyles = StyleSheet.create({
  panel: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 4,
    borderRadius: borderRadius.lg,
    padding: 16,
    ...shadows.card,
  },
  panelTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 14,
  },
  kpiRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  kpiCard: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  kpiValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  kpiLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    textAlign: "center",
  },
  kpiSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#cbd5e1",
    textAlign: "center",
  },
  kpiDivider: {
    width: StyleSheet.hairlineWidth,
    height: 36,
    backgroundColor: colors.surface.border,
    marginHorizontal: 4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    marginVertical: 14,
  },
  subTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  productRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  productRank: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: colors.brand[500],
    width: 20,
    textAlign: "center",
  },
  productCenter: {
    flex: 1,
    gap: 5,
  },
  productName: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  barTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.brand[50],
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: colors.brand[500],
  },
  productQty: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    minWidth: 52,
    textAlign: "right",
  },
});

// ─── Main screen ─────────────────────────────────────────────────────────────

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
  const itemCount = order.lineItems.reduce((s, i) => s + Number(i.qty), 0);
  const loadItems = useOrderStore((s) => s.loadItems);
  const currentItems = useOrderStore((s) => s.items);

  const handleReorder = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    const mapped = order.lineItems
      .filter((l) => l.product)
      .map((l) => ({
        productId: l.productId,
        name: l.product!.name,
        unitPrice: Number(l.unitPrice),
        unit: l.product!.unit,
        quantity: l.qty,
      }));

    const doReorder = () => {
      loadItems(mapped);
      router.push("/(customer)/order");
    };

    if (currentItems.length > 0) {
      Alert.alert(
        "Replace your current cart with this order?",
        undefined,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Replace", onPress: doReorder },
        ],
      );
    } else {
      doReorder();
    }
  };

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
        {order.status === "DELIVERED" ? (
          <Pressable style={styles.reorderBtn} onPress={handleReorder} accessibilityRole="button" accessibilityLabel="Reorder">
            <Text style={styles.reorderBtnText}>Reorder</Text>
          </Pressable>
        ) : (
          <Text style={styles.chevron}>›</Text>
        )}
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
          ListHeaderComponent={
            activeFilter === "ALL" ? <AnalyticsPanel orders={allOrders} /> : null
          }
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
  reorderBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
    backgroundColor: colors.brand[50],
    borderWidth: 1,
    borderColor: colors.brand[500],
  },
  reorderBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
});
