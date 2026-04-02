import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useRouter } from "expo-router";
import { useAuthStore } from "../../lib/auth-store";
import { useAdminDashboard, useAdminOrders } from "../../lib/api/admin";

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fef3c7", text: "#92400e" },
  CONFIRMED: { bg: "#dbeafe", text: "#1e40af" },
  OUT_FOR_DELIVERY: { bg: "#ede9fe", text: "#5b21b6" },
  DELIVERED: { bg: "#d1fae5", text: "#065f46" },
  CANCELLED: { bg: "#f1f5f9", text: "#475569" },
};

interface KpiCardProps {
  label: string;
  value: string | number;
  icon: string;
  iconBg: string;
  iconColor: string;
  onPress?: () => void;
}

function KpiCard({ label, value, icon, iconBg, iconColor, onPress }: KpiCardProps) {
  return (
    <Pressable style={styles.kpiCard} onPress={onPress}>
      <View style={[styles.kpiIcon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon as any} size={20} color={iconColor} />
      </View>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </Pressable>
  );
}

interface QuickActionProps {
  icon: string;
  label: string;
  onPress: () => void;
  color?: string;
}

function QuickAction({ icon, label, onPress, color = "#2563EB" }: QuickActionProps) {
  return (
    <Pressable style={styles.quickAction} onPress={onPress}>
      <View style={[styles.quickActionIcon, { backgroundColor: color + "18" }]}>
        <Ionicons name={icon as any} size={22} color={color} />
      </View>
      <Text style={styles.quickActionLabel}>{label}</Text>
    </Pressable>
  );
}

export default function AdminDashboardScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { data: stats, isLoading: statsLoading, isError: statsError, refetch: refetchStats } = useAdminDashboard();
  const {
    data: ordersData,
    isLoading: ordersLoading,
    refetch: refetchOrders,
  } = useAdminOrders({ limit: 5 });

  const isRefreshing = false;
  const onRefresh = () => {
    refetchStats();
    refetchOrders();
  };

  const displayName = user?.username ?? "Admin";
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerGreeting}>{greeting},</Text>
        <Text style={styles.headerName}>{displayName}</Text>
        <Text style={styles.headerSub}>Here's your business overview</Text>
      </View>

      {/* KPI Grid */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Overview</Text>
        {statsLoading ? (
          <ActivityIndicator style={{ marginVertical: 24 }} color="#2563EB" />
        ) : statsError ? (
          <Pressable
            style={styles.errorBanner}
            onPress={() => refetchStats()}
            accessibilityRole="button"
          >
            <Ionicons name="alert-circle-outline" size={18} color="#dc2626" />
            <Text style={styles.errorText}>Could not load stats. Tap to retry.</Text>
          </Pressable>
        ) : (
          <View style={styles.kpiGrid}>
            <KpiCard
              label="Pending Orders"
              value={stats?.pendingOrders ?? 0}
              icon="receipt-outline"
              iconBg="#fef3c7"
              iconColor="#d97706"
              onPress={() => router.push("/(admin)/orders")}
            />
            <KpiCard
              label="Active Routes"
              value={stats?.activeRoutes ?? 0}
              icon="map-outline"
              iconBg="#dbeafe"
              iconColor="#2563EB"
              onPress={() => router.push("/(admin)/routes")}
            />
            <KpiCard
              label="Overdue Invoices"
              value={stats?.invoicesOverdue ?? 0}
              icon="alert-circle-outline"
              iconBg="#fee2e2"
              iconColor="#dc2626"
              onPress={() => router.push("/(admin)/finance")}
            />
            <KpiCard
              label="Customers"
              value={stats?.totalCustomers ?? 0}
              icon="people-outline"
              iconBg="#d1fae5"
              iconColor="#059669"
              onPress={() => router.push("/(admin)/customers")}
            />
            <KpiCard
              label="Revenue (Month)"
              value={`$${Number(stats?.revenueThisMonth ?? 0).toFixed(0)}`}
              icon="trending-up-outline"
              iconBg="#ede9fe"
              iconColor="#7c3aed"
              onPress={() => router.push("/(admin)/finance")}
            />
            <KpiCard
              label="Returns"
              value={stats?.returnsToProcess ?? 0}
              icon="arrow-undo-outline"
              iconBg="#fff7ed"
              iconColor="#ea580c"
              onPress={() => router.push("/(admin)/returns")}
            />
            <KpiCard
              label="Low Stock"
              value={stats?.lowStockProducts ?? 0}
              icon="cube-outline"
              iconBg="#fce7f3"
              iconColor="#db2777"
              onPress={() => router.push("/(admin)/products")}
            />
            <KpiCard
              label="Active Drivers"
              value={stats?.activeDrivers ?? 0}
              icon="car-outline"
              iconBg="#e0f2fe"
              iconColor="#0284c7"
              onPress={() => router.push("/(admin)/drivers")}
            />
          </View>
        )}
      </View>

      {/* Recent Orders */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent Orders</Text>
          <Pressable onPress={() => router.push("/(admin)/orders")}>
            <Text style={styles.seeAll}>See all</Text>
          </Pressable>
        </View>
        {ordersLoading ? (
          <ActivityIndicator style={{ marginVertical: 24 }} color="#2563EB" />
        ) : !ordersData?.data?.length ? (
          <View style={styles.emptyState}>
            <Ionicons name="receipt-outline" size={36} color="#cbd5e1" />
            <Text style={styles.emptyText}>No orders yet</Text>
          </View>
        ) : (
          ordersData.data.map((order) => {
            const sc = STATUS_COLORS[order.status] ?? {
              bg: "#f1f5f9",
              text: "#475569",
            };
            return (
              <Pressable
                key={order.id}
                style={styles.orderRow}
                onPress={() => router.push(`/(admin)/orders/${order.id}` as any)}
              >
                <View style={styles.orderRowLeft}>
                  <Text style={styles.orderNumber}>{order.orderNumber}</Text>
                  <Text style={styles.orderCustomer}>
                    {order.customer?.businessName ?? "—"}
                  </Text>
                </View>
                <View style={styles.orderRowRight}>
                  <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
                    <Text style={[styles.statusText, { color: sc.text }]}>
                      {order.status}
                    </Text>
                  </View>
                  <Text style={styles.orderAmount}>
                    ${Number(order.total).toFixed(2)}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>

      {/* Quick Actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.quickActionsGrid}>
          <QuickAction
            icon="add-circle-outline"
            label="New Order"
            onPress={() => router.push("/(admin)/orders")}
            color="#2563EB"
          />
          <QuickAction
            icon="map-outline"
            label="Routes"
            onPress={() => router.push("/(admin)/routes")}
            color="#7c3aed"
          />
          <QuickAction
            icon="car-outline"
            label="Drivers"
            onPress={() => router.push("/(admin)/drivers")}
            color="#0284c7"
          />
          <QuickAction
            icon="cube-outline"
            label="Products"
            onPress={() => router.push("/(admin)/products")}
            color="#db2777"
          />
          <QuickAction
            icon="wallet-outline"
            label="Finance"
            onPress={() => router.push("/(admin)/finance")}
            color="#059669"
          />
          <QuickAction
            icon="arrow-undo-outline"
            label="Returns"
            onPress={() => router.push("/(admin)/returns")}
            color="#ea580c"
          />
          <QuickAction
            icon="people-outline"
            label="Customers"
            onPress={() => router.push("/(admin)/customers")}
            color="#d97706"
          />
          <QuickAction
            icon="settings-outline"
            label="Settings"
            onPress={() => router.push("/(admin)/profile")}
            color="#64748b"
          />
        </View>
      </View>

      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  header: {
    backgroundColor: "#1e3a5f",
    padding: 20,
    paddingTop: 16,
    paddingBottom: 28,
  },
  headerGreeting: {
    color: "#94a3b8",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  headerName: {
    color: "#fff",
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    marginTop: 2,
  },
  headerSub: {
    color: "#64748b",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
  },
  section: {
    marginTop: 16,
    marginHorizontal: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    marginBottom: 12,
  },
  seeAll: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#2563EB",
    marginBottom: 12,
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  kpiCard: {
    width: "47%",
    backgroundColor: "#f8fafc",
    borderRadius: 10,
    padding: 14,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  kpiIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  kpiValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  kpiLabel: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  orderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  orderRowLeft: {
    flex: 1,
    gap: 2,
  },
  orderNumber: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  orderCustomer: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  orderRowRight: {
    alignItems: "flex-end",
    gap: 4,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 100,
  },
  statusText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  orderAmount: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  quickActionsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  quickAction: {
    width: "30%",
    alignItems: "center",
    paddingVertical: 12,
  },
  quickActionIcon: {
    width: 52,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  quickActionLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "#475569",
    textAlign: "center",
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 24,
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fee2e2",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginVertical: 8,
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#dc2626",
    flex: 1,
  },
});
