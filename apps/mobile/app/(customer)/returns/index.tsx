import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { format, parseISO } from "date-fns";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useMyReturns, type Return, type ReturnStatus, type ReturnReason } from "../../../lib/api/returns";
import { NetworkError } from "../../../components/NetworkError";

const STATUS_CONFIG: Record<ReturnStatus, { label: string; color: string; bg: string; icon: string }> = {
  PENDING:   { label: "Pending",   color: colors.warning.DEFAULT, bg: colors.warning.bg,  icon: "time-outline" },
  PROCESSED: { label: "Processed", color: colors.success.DEFAULT, bg: colors.success.bg,  icon: "checkmark-circle-outline" },
  CANCELLED: { label: "Cancelled", color: "#94a3b8",              bg: colors.surface.raised, icon: "close-circle-outline" },
};

const REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED:         "Damaged goods",
  WRONG_ITEM:      "Wrong item delivered",
  CUSTOMER_REFUSED: "Customer refused",
  QUALITY_ISSUE:   "Quality issue",
  EXCESS_ORDER:    "Excess order",
};

function ReturnCard({ item }: { item: Return }) {
  const cfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.PENDING;
  const dateLabel = format(parseISO(item.createdAt), "MMM d, yyyy");
  const itemCount = item.items?.length ?? 0;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/(customer)/returns/${item.id}` as any)}
      accessibilityRole="button"
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.orderRef}>
            {item.order?.orderNumber ? `Order ${item.order.orderNumber}` : "Return"}
          </Text>
          <Text style={styles.dateText}>{dateLabel}</Text>
        </View>
        <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as any} size={13} color={cfg.color} />
          <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.reasonPill}>
          <Ionicons name="return-down-back-outline" size={14} color="#94a3b8" />
          <Text style={styles.reasonText}>{REASON_LABELS[item.reason] ?? item.reason}</Text>
        </View>
        <Text style={styles.itemCount}>
          {itemCount} item{itemCount !== 1 ? "s" : ""}
        </Text>
      </View>
    </Pressable>
  );
}

export default function ReturnsScreen() {
  const { data, isLoading, isError, refetch } = useMyReturns();

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Returns" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Returns" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const returns = data?.data ?? [];

  return (
    <>
      <Stack.Screen options={{ title: "Returns" }} />
      <FlatList
        data={returns}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="return-down-back-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyText}>No returns on record.</Text>
          </View>
        }
        renderItem={({ item }) => <ReturnCard item={item} />}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 10,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: {
    alignItems: "center",
    paddingTop: 64,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
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
  cardLeft: { gap: 2 },
  orderRef: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  dateText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  statusText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  reasonPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flex: 1,
  },
  reasonText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  itemCount: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
