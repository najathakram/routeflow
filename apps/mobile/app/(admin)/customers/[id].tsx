import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@routeflow/ui/tokens";
import { useAdminCustomer, useAdminOrders, useAdminInvoices } from "../../../lib/api/admin";

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fef3c7", text: "#92400e" },
  CONFIRMED: { bg: "#dbeafe", text: "#1e40af" },
  OUT_FOR_DELIVERY: { bg: "#ede9fe", text: "#5b21b6" },
  DELIVERED: { bg: "#d1fae5", text: "#065f46" },
  CANCELLED: { bg: "#f1f5f9", text: "#475569" },
};

const CUSTOMER_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  ACTIVE: { bg: "#d1fae5", text: "#065f46" },
  INACTIVE: { bg: "#f1f5f9", text: "#475569" },
};

export default function AdminCustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const { data: customer, isLoading, isError, refetch } = useAdminCustomer(id);
  const { data: ordersData } = useAdminOrders({ customerId: id, limit: 5 });
  const { data: invoicesData } = useAdminInvoices({ customerId: id });

  const recentOrders = ordersData?.data ?? [];
  const invoices = invoicesData?.data ?? [];
  const overdueInvoices = invoices.filter((inv) => inv.status === "OVERDUE");
  const outstandingTotal = invoices.reduce((sum, inv) => sum + (inv.balanceDue ?? 0), 0);

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#2563EB" />
      </View>
    );
  }

  if (isError || !customer) {
    return (
      <View style={styles.centered}>
        <Ionicons name="cloud-offline-outline" size={40} color="#cbd5e1" />
        <Text style={styles.errorText}>Failed to load customer</Text>
        <Pressable style={styles.retryBtn} onPress={() => refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const csc = CUSTOMER_STATUS_COLORS[customer.status] ?? { bg: "#f1f5f9", text: "#475569" };

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* Business Info Card */}
      <View style={styles.card}>
        <View style={styles.avatarRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {customer.businessName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={styles.avatarInfo}>
            <Text style={styles.businessName}>{customer.businessName}</Text>
            <View style={[styles.statusBadge, { backgroundColor: csc.bg }]}>
              <Text style={[styles.statusText, { color: csc.text }]}>
                {customer.status}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.infoGrid}>
          {customer.contactName ? (
            <View style={styles.infoItem}>
              <Ionicons name="person-outline" size={14} color="#94a3b8" />
              <View>
                <Text style={styles.infoLabel}>Contact</Text>
                <Text style={styles.infoValue}>{customer.contactName}</Text>
              </View>
            </View>
          ) : null}
          {customer.phone ? (
            <View style={styles.infoItem}>
              <Ionicons name="call-outline" size={14} color="#94a3b8" />
              <View>
                <Text style={styles.infoLabel}>Phone</Text>
                <Text style={styles.infoValue}>{customer.phone}</Text>
              </View>
            </View>
          ) : null}
          {customer.email ? (
            <View style={styles.infoItem}>
              <Ionicons name="mail-outline" size={14} color="#94a3b8" />
              <View>
                <Text style={styles.infoLabel}>Email</Text>
                <Text style={styles.infoValue}>{customer.email}</Text>
              </View>
            </View>
          ) : null}
          {customer.creditLimit != null ? (
            <View style={styles.infoItem}>
              <Ionicons name="card-outline" size={14} color="#94a3b8" />
              <View>
                <Text style={styles.infoLabel}>Credit Limit</Text>
                <Text style={styles.infoValue}>
                  ${Number(customer.creditLimit).toFixed(2)}
                </Text>
              </View>
            </View>
          ) : null}
          <View style={styles.infoItem}>
            <Ionicons name="calendar-outline" size={14} color="#94a3b8" />
            <View>
              <Text style={styles.infoLabel}>Member Since</Text>
              <Text style={styles.infoValue}>
                {new Date(customer.createdAt).toLocaleDateString()}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Balance Summary */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Balance</Text>
        <View style={styles.balanceRow}>
          <View style={styles.balanceStat}>
            <Text style={styles.balanceStatValue}>
              ${outstandingTotal.toFixed(2)}
            </Text>
            <Text style={styles.balanceStatLabel}>Outstanding</Text>
          </View>
          <View style={styles.balanceDivider} />
          <View style={styles.balanceStat}>
            <Text
              style={[
                styles.balanceStatValue,
                overdueInvoices.length > 0 && { color: "#dc2626" },
              ]}
            >
              {overdueInvoices.length}
            </Text>
            <Text style={styles.balanceStatLabel}>Overdue Invoices</Text>
          </View>
          <View style={styles.balanceDivider} />
          <View style={styles.balanceStat}>
            <Text style={styles.balanceStatValue}>{invoices.length}</Text>
            <Text style={styles.balanceStatLabel}>Total Invoices</Text>
          </View>
        </View>
        <Pressable
          style={styles.viewAllBtn}
          onPress={() => router.push("/(admin)/finance/invoices" as any)}
        >
          <Text style={styles.viewAllText}>View Invoices</Text>
          <Ionicons name="arrow-forward" size={14} color="#2563EB" />
        </Pressable>
      </View>

      {/* Recent Orders */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Recent Orders</Text>
          <Pressable onPress={() => router.push("/(admin)/orders")}>
            <Text style={styles.seeAllText}>See all</Text>
          </Pressable>
        </View>
        {recentOrders.length === 0 ? (
          <View style={styles.emptyMini}>
            <Text style={styles.emptyMiniText}>No orders yet</Text>
          </View>
        ) : (
          recentOrders.map((order, index) => {
            const sc = STATUS_COLORS[order.status] ?? { bg: "#f1f5f9", text: "#475569" };
            return (
              <Pressable
                key={order.id}
                style={[styles.orderRow, index === 0 && { borderTopWidth: 0 }]}
                onPress={() => router.push(`/(admin)/orders/${order.id}` as any)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderNumber}>{order.orderNumber}</Text>
                  <Text style={styles.orderDate}>
                    {new Date(order.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
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

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "#f8fafc",
  },
  errorText: { fontSize: 15, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "#2563EB",
    borderRadius: 8,
  },
  retryText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 14 },
  card: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  avatarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 16,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#dbeafe",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 22, fontFamily: "Inter_700Bold", color: "#1e40af" },
  avatarInfo: { flex: 1, gap: 6 },
  businessName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100, alignSelf: "flex-start" },
  statusText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  infoGrid: { gap: 10 },
  infoItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  infoLabel: { fontSize: 11, fontFamily: "Inter_400Regular", color: "#94a3b8" },
  infoValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
    marginTop: 1,
  },
  cardTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  seeAllText: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#2563EB", marginBottom: 8 },
  balanceRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  balanceStat: { flex: 1, alignItems: "center" },
  balanceStatValue: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  balanceStatLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
    marginTop: 2,
  },
  balanceDivider: {
    width: 1,
    height: 36,
    backgroundColor: colors.surface.border,
  },
  viewAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
    backgroundColor: "#eff6ff",
    borderRadius: 8,
  },
  viewAllText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#2563EB" },
  orderRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  orderNumber: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  orderDate: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#94a3b8", marginTop: 2 },
  orderAmount: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  emptyMini: { paddingVertical: 16, alignItems: "center" },
  emptyMiniText: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#94a3b8" },
});
