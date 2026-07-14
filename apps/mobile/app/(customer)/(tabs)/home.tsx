/**
 * RF-218: Buyer dashboard home screen.
 * Shows account balance (unpaid invoices), last order summary, and
 * standing-order count — enough context for a daily check-in without
 * requiring the buyer to dig through Orders or Invoices first.
 */
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useBuyerDashboard, useBuyerInvoices } from "../../../lib/api/buyer";
import { useBuyerSessionStore } from "../../../lib/buyer-session-store";

export default function BuyerHomeScreen() {
  const router = useRouter();
  const { activeSeller } = useBuyerSessionStore();

  const {
    data: dashboard,
    isLoading: dashLoading,
    isFetching: dashFetching,
    refetch: refetchDash,
  } = useBuyerDashboard();

  // Balance: unpaid / overdue invoices total
  const {
    data: invoiceData,
    isFetching: invFetching,
    refetch: refetchInv,
  } = useBuyerInvoices({ statuses: ["SENT", "OVERDUE", "PARTIAL"], limit: 50 });

  const isLoading = dashLoading;
  const isFetching = dashFetching || invFetching;
  const onRefresh = () => {
    refetchDash();
    refetchInv();
  };

  const stats = dashboard?.stats;
  const recentOrders = dashboard?.recentOrders ?? [];
  const lastOrder = recentOrders[0];

  const unpaidTotal = (invoiceData?.data ?? []).reduce(
    (sum, inv) => sum + Number(inv.amountDue ?? inv.balanceDue ?? inv.total ?? 0),
    0,
  );
  const overdueCount = (invoiceData?.data ?? []).filter(
    (inv) => inv.status === "OVERDUE" || inv.isOverdue,
  ).length;

  const templateCount = stats?.templateCount ?? 0;
  const activeOrderCount = stats?.activeOrders ?? 0;
  const spend30d = stats?.spend30d ?? 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={activeSeller?.tenant.name ?? "Home"}
        trailing={
          <NavAction
            label="New order"
            bold
            onPress={() => router.push("/(customer)/orders/cart")}
          />
        }
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={onRefresh} />
        }
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : (
          <>
            {/* ── Balance card ────────────────────────────── */}
            <Pressable
              style={styles.balanceCard}
              onPress={() => router.push("/(customer)/(tabs)/invoices")}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.balanceLabel}>Outstanding balance</Text>
                <Text
                  style={[styles.balanceAmount, unpaidTotal > 0 && { color: ios.system.orangeInk }]}
                >
                  ${unpaidTotal.toFixed(2)}
                </Text>
                {overdueCount > 0 ? (
                  <Text style={styles.overdueNote}>
                    {overdueCount} invoice{overdueCount > 1 ? "s" : ""} overdue
                  </Text>
                ) : unpaidTotal === 0 ? (
                  <Text style={styles.allClearNote}>All invoices paid</Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={18} color={ios.gray[3]} />
            </Pressable>

            {/* ── Stats strip ─────────────────────────────── */}
            <View style={styles.statsRow}>
              <View style={styles.statCell}>
                <Text style={styles.statValue}>{activeOrderCount}</Text>
                <Text style={styles.statLabel}>Active orders</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCell}>
                <Text style={styles.statValue}>${spend30d.toFixed(0)}</Text>
                <Text style={styles.statLabel}>Spend (30 d)</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCell}>
                <Text style={styles.statValue}>{templateCount}</Text>
                <Text style={styles.statLabel}>Standing orders</Text>
              </View>
            </View>

            {/* ── Last order ──────────────────────────────── */}
            {lastOrder ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>LAST ORDER</Text>
                <Pressable
                  style={styles.orderCard}
                  onPress={() => router.push(`/(customer)/orders/${lastOrder.id}`)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.orderNum}>
                      {lastOrder.orderNumber ? `#${lastOrder.orderNumber}` : "Order"}
                    </Text>
                    <Text style={styles.orderMeta}>
                      {new Date(lastOrder.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                      {" · "}
                      {lastOrder.itemCount ??
                        (lastOrder.lineItems ?? []).reduce((s, i) => s + Number(i.qty), 0)}{" "}
                      items
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <StatusPill status={lastOrder.status} />
                    <Text style={styles.orderTotal}>
                      ${(Number(lastOrder.total) || 0).toFixed(2)}
                    </Text>
                  </View>
                </Pressable>
              </View>
            ) : null}

            {/* ── Quick actions ────────────────────────────── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>QUICK ACTIONS</Text>
              <View style={styles.actionsCard}>
                <ActionRow
                  icon="grid-outline"
                  iconBg={ios.system.purpleWash}
                  iconColor={ios.system.purpleInk}
                  title="Browse catalog"
                  onPress={() => router.push("/(customer)/(tabs)/catalog")}
                />
                <ActionRow
                  icon="document-text-outline"
                  iconBg={ios.brandWash}
                  iconColor={ios.brand}
                  title="Invoices"
                  onPress={() => router.push("/(customer)/(tabs)/invoices")}
                />
                <ActionRow
                  icon="cube-outline"
                  iconBg={ios.system.orangeWash}
                  iconColor={ios.system.orangeInk}
                  title="Your Shelf"
                  onPress={() => router.push("/(customer)/shelf")}
                />
                <ActionRow
                  icon="refresh-outline"
                  iconBg={ios.system.orangeWash}
                  iconColor={ios.system.orangeInk}
                  title="Standing orders"
                  badge={templateCount > 0 ? String(templateCount) : undefined}
                  onPress={() => router.push("/(customer)/standing-orders")}
                  last
                />
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<
    string,
    { variant: "green" | "orange" | "brand" | "gray" | "red"; label: string }
  > = {
    PENDING: { variant: "orange", label: "Pending" },
    CONFIRMED: { variant: "brand", label: "Confirmed" },
    OUT_FOR_DELIVERY: { variant: "brand", label: "Out for delivery" },
    DELIVERED: { variant: "green", label: "Delivered" },
    CANCELLED: { variant: "gray", label: "Cancelled" },
  };
  const p = map[status] ?? { variant: "gray" as const, label: status };
  return (
    <Pill variant={p.variant} dot>
      {p.label}
    </Pill>
  );
}

function ActionRow({
  icon,
  iconBg,
  iconColor,
  title,
  badge,
  onPress,
  last,
}: {
  icon: any;
  iconBg: string;
  iconColor: string;
  title: string;
  badge?: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable style={[styles.actionRow, !last && styles.actionRowBorder]} onPress={onPress}>
      <View style={[styles.actionIcon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={16} color={iconColor} />
      </View>
      <Text style={styles.actionTitle}>{title}</Text>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 60, alignItems: "center" },
  balanceCard: {
    flexDirection: "row",
    alignItems: "center",
    margin: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 16,
    padding: 18,
  },
  balanceLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  balanceAmount: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -1,
    marginTop: 2,
  },
  overdueNote: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.system.redInk,
    marginTop: 3,
  },
  allClearNote: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.system.greenInk,
    marginTop: 3,
  },
  statsRow: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    overflow: "hidden",
  },
  statCell: { flex: 1, alignItems: "center", paddingVertical: 14 },
  statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: ios.separator },
  statValue: { fontSize: 20, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.5 },
  statLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
    textAlign: "center",
  },
  section: { paddingHorizontal: 16, marginBottom: 16 },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 8,
    paddingLeft: 4,
  },
  orderCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  orderNum: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  orderMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  orderTotal: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  actionsCard: { backgroundColor: ios.bgElev, borderRadius: 14, overflow: "hidden" },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 12,
  },
  actionRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  actionIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  actionTitle: { flex: 1, fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  badge: {
    backgroundColor: ios.brand,
    borderRadius: 10,
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: "center",
  },
  badgeText: { fontSize: 11, fontFamily: "Inter_700Bold", color: "#fff" },
});
