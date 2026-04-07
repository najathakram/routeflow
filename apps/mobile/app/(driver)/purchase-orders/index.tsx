import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useOpenPurchaseOrders, type PurchaseOrder, type POStatus } from "../../../lib/api/purchase-orders";
import { NetworkError } from "../../../components/NetworkError";

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<POStatus, { label: string; color: string; bg: string }> = {
  DRAFT: { label: "Draft", color: "#64748b", bg: "#f1f5f9" },
  SENT: { label: "Sent", color: colors.brand[600], bg: colors.brand[50] },
  PARTIALLY_RECEIVED: { label: "Partial", color: "#d97706", bg: "#fef3c7" },
  RECEIVED: { label: "Received", color: colors.success.DEFAULT, bg: colors.success.bg },
  CLOSED: { label: "Closed", color: "#94a3b8", bg: "#f8fafc" },
};

function StatusBadge({ status }: { status: POStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.DRAFT;
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

// ─── PO card ──────────────────────────────────────────────────────────────────

function POCard({ po }: { po: PurchaseOrder }) {
  const itemCount = po.items?.length ?? 0;
  const pendingItems = po.items?.filter(
    (i) => i.qtyReceived < i.qtyOrdered,
  ).length ?? 0;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/(driver)/purchase-orders/${po.id}` as any)}
      accessibilityRole="button"
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleGroup}>
          <Text style={styles.poNumber}>{po.poNumber}</Text>
          <Text style={styles.supplierName}>{po.supplier?.name ?? "Unknown Supplier"}</Text>
        </View>
        <View style={styles.cardRight}>
          <StatusBadge status={po.status} />
          <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
        </View>
      </View>

      <View style={styles.cardMeta}>
        <View style={styles.metaChip}>
          <Ionicons name="cube-outline" size={13} color="#64748b" />
          <Text style={styles.metaText}>{itemCount} product{itemCount !== 1 ? "s" : ""}</Text>
        </View>
        {pendingItems > 0 && (
          <View style={[styles.metaChip, { backgroundColor: "#fef3c7" }]}>
            <Ionicons name="time-outline" size={13} color="#d97706" />
            <Text style={[styles.metaText, { color: "#d97706" }]}>
              {pendingItems} pending
            </Text>
          </View>
        )}
        {po.expectedDate && (
          <View style={styles.metaChip}>
            <Ionicons name="calendar-outline" size={13} color="#64748b" />
            <Text style={styles.metaText}>
              {new Date(po.expectedDate).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function PurchaseOrdersScreen() {
  const { data, isLoading, isError, refetch } = useOpenPurchaseOrders();
  const pos: PurchaseOrder[] = data?.data ?? [];

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Purchase Orders" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Purchase Orders" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Purchase Orders" }} />
      <FlatList
        style={styles.container}
        data={pos}
        keyExtractor={(po) => po.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyTitle}>No Open POs</Text>
            <Text style={styles.emptySubtitle}>
              All purchase orders are received or closed.
            </Text>
          </View>
        }
        renderItem={({ item }) => <POCard po={item} />}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: {
    padding: 16,
    paddingBottom: 48,
    gap: 10,
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
    gap: 8,
  },
  cardTitleGroup: { flex: 1, gap: 2 },
  poNumber: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  supplierName: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  cardRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },

  cardMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surface.raised,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  metaText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },

  emptyState: {
    alignItems: "center",
    paddingTop: 80,
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
  },
});
