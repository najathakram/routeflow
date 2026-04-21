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
import { FilterChipRow, NavAction, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useState } from "react";
import { useBuyerOrders, type BuyerOrder } from "../../../lib/api/buyer";
import { useBuyerSessionStore } from "../../../lib/buyer-session-store";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "PENDING", label: "Pending" },
  { id: "CONFIRMED", label: "Confirmed" },
  { id: "DELIVERED", label: "Delivered" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function orderPill(status: string) {
  switch (status) {
    case "PENDING": return { variant: "orange" as const, label: "Pending" };
    case "CONFIRMED": return { variant: "brand" as const, label: "Confirmed" };
    case "DRAFT": return { variant: "gray" as const, label: "Draft" };
    case "IN_TRANSIT": return { variant: "brand" as const, label: "In transit" };
    case "DELIVERED": return { variant: "green" as const, label: "Delivered" };
    case "CANCELLED": return { variant: "gray" as const, label: "Cancelled" };
    default: return { variant: "gray" as const, label: status };
  }
}

function formatCurrency(n: number): string {
  return `$${(n ?? 0).toFixed(2)}`;
}

export default function CustomerOrdersScreen() {
  const router = useRouter();
  const { activeSeller } = useBuyerSessionStore();
  const [filter, setFilter] = useState<FilterId>("ALL");

  const statusParam = filter === "ALL" ? undefined : filter;
  const { data, isLoading, isFetching, refetch } = useBuyerOrders({
    status: statusParam,
    limit: 30,
  });
  const orders = data?.data ?? [];

  const totalItems = (order: BuyerOrder) =>
    order.lineItems.reduce((s, i) => s + i.qty, 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={activeSeller?.tenant.name ?? "Orders"}
        trailing={
          <NavAction
            label="New"
            bold
            onPress={() => router.push("/(customer)/orders/cart")}
          />
        }
      />

      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) =>
          setFilter(
            (FILTERS.find((f) => f.label === label)?.id as FilterId) ?? "ALL",
          )
        }
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : orders.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No orders yet.</Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(customer)/(tabs)/catalog")}
            >
              <Ionicons name="grid-outline" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Browse catalog</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.list}>
            {orders.map((order) => {
              const p = orderPill(order.status);
              const dateLabel = new Date(order.createdAt).toLocaleDateString(undefined, {
                month: "short", day: "numeric", year: "numeric",
              });
              const itemCount = totalItems(order);
              const total = order.total ?? order.lineItems.reduce((s, i) => s + i.qty * i.unitPrice, 0);

              return (
                <Pressable
                  key={order.id}
                  style={styles.card}
                  onPress={() => router.push(`/(customer)/orders/${order.id}`)}
                >
                  <View style={styles.cardHead}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardNumber}>
                        {order.orderNumber ? `#${order.orderNumber}` : "Order"}
                      </Text>
                      <Text style={styles.cardMeta}>
                        {dateLabel} · {itemCount} item{itemCount !== 1 ? "s" : ""}
                      </Text>
                    </View>
                    <Pill variant={p.variant} dot>{p.label}</Pill>
                  </View>
                  <View style={styles.cardFoot}>
                    <Text style={styles.cardTotal}>{formatCurrency(total)}</Text>
                    <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 14 },
  empty: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  primaryBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  list: { paddingHorizontal: 16, gap: 8, paddingBottom: 32 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardNumber: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  cardMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  cardFoot: { marginTop: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTotal: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label, fontVariant: ["tabular-nums"] },
});
