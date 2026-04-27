import { useMemo, useState } from "react";
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
import {
  FilterChipRow,
  NavBar,
  Pill,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useMyOrders, type Order } from "../../lib/api/orders";

const STATUS_FILTERS = [
  { id: "OUT_FOR_DELIVERY", label: "Active" },
  { id: "CONFIRMED", label: "Confirmed" },
  { id: "DELIVERED", label: "Delivered" },
  { id: "ALL", label: "All" },
] as const;

type FilterId = (typeof STATUS_FILTERS)[number]["id"];

function statusPill(status: string): {
  variant: "brand" | "green" | "orange" | "red" | "gray";
  label: string;
} {
  switch (status) {
    case "PENDING":
      return { variant: "orange", label: "Pending" };
    case "CONFIRMED":
      return { variant: "brand", label: "Confirmed" };
    case "OUT_FOR_DELIVERY":
      return { variant: "brand", label: "Out for delivery" };
    case "DELIVERED":
      return { variant: "green", label: "Delivered" };
    case "CANCELLED":
      return { variant: "red", label: "Cancelled" };
    default:
      return { variant: "gray", label: status };
  }
}

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function DriverOrdersScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("OUT_FOR_DELIVERY");
  const [search, setSearch] = useState("");

  const statusParam = filter === "ALL" ? undefined : filter;
  const { data, isLoading, isFetching, refetch } = useMyOrders({
    status: statusParam,
    limit: 50,
  });
  const orders = data?.data ?? [];

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return orders;
    return orders.filter(
      (o) =>
        o.orderNumber.toLowerCase().includes(s) ||
        (o as any).customer?.businessName?.toLowerCase().includes(s),
    );
  }, [orders, search]);

  const chipLabel = (id: FilterId) =>
    STATUS_FILTERS.find((f) => f.id === id)?.label ?? "All";
  const chipIdFromLabel = (label: string): FilterId =>
    (STATUS_FILTERS.find((f) => f.label === label)?.id ?? "ALL") as FilterId;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="My orders" />

      <SearchBar
        placeholder="Search orders…"
        value={search}
        onChangeText={setSearch}
      />

      <FilterChipRow
        chips={STATUS_FILTERS.map((f) => ({ label: f.label }))}
        value={chipLabel(filter)}
        onChange={(label) => setFilter(chipIdFromLabel(label))}
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
        ) : filtered.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="cube-outline" size={40} color={ios.label3} />
            <Text style={styles.emptyTitle}>No orders</Text>
            <Text style={styles.emptySub}>
              {search
                ? "No orders match your search."
                : "No orders in this status."}
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {filtered.map((o) => (
              <OrderRow key={o.id} order={o} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function OrderRow({ order }: { order: Order }) {
  const s = statusPill(order.status);
  const itemCount = order.lineItems?.length ?? 0;
  const customer = (order as any).customer?.businessName;

  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {order.orderNumber}
            </Text>
            {order.urgent ? (
              <Pill variant="red" small>
                Urgent
              </Pill>
            ) : null}
          </View>
          {customer ? (
            <Text style={styles.rowSub} numberOfLines={1}>
              {customer}
            </Text>
          ) : null}
          <Text style={styles.rowSub}>
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </Text>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.rowTotal}>{formatCurrency(order.total)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 10 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label },
  emptySub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  row: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  rowTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  rowSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  rowFoot: { marginTop: 10 },
  rowTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
