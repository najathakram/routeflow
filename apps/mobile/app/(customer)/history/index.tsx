import { useMemo } from "react";
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { format, parseISO } from "date-fns";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { MOCK_HISTORY, HistoryOrder } from "../../../data/mockData";

type Section = { title: string; data: HistoryOrder[] };

function statusForBadge(
  status: HistoryOrder["status"],
): "DELIVERED" | "IN_PROGRESS" | "PENDING" | "CANCELLED" {
  if (status === "IN_TRANSIT") return "IN_PROGRESS";
  return status;
}

function OrderRow({ order }: { order: HistoryOrder }) {
  const date = parseISO(order.date);
  const timeLabel = format(date, "h:mm a");
  const itemCount = order.items.reduce((s, i) => s + i.qty, 0);

  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push(`/(customer)/history/${order.id}`)}
    >
      <View style={styles.rowLeft}>
        <Text style={styles.orderId}>{order.id}</Text>
        <Text style={styles.orderMeta}>
          {itemCount} item{itemCount !== 1 ? "s" : ""} · {timeLabel}
        </Text>
        <StatusBadge status={statusForBadge(order.status)} />
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.total}>${order.total.toFixed(2)}</Text>
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

export default function HistoryScreen() {
  const sections: Section[] = useMemo(() => {
    const groups = new Map<string, HistoryOrder[]>();
    for (const order of [...MOCK_HISTORY].sort(
      (a, b) => parseISO(b.date).getTime() - parseISO(a.date).getTime(),
    )) {
      const key = format(parseISO(order.date), "MMMM d, yyyy");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(order);
    }
    return Array.from(groups.entries()).map(([title, data]) => ({ title, data }));
  }, []);

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
