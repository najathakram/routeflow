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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavAction,
  NavBar,
  Pill,
  SearchBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminOrders, type AdminOrder } from "../../../../lib/api/admin";

const STATUS_FILTERS = [
  { id: "PENDING", label: "Pending" },
  { id: "CONFIRMED", label: "Confirmed" },
  { id: "OUT_FOR_DELIVERY", label: "Out" },
  { id: "DELIVERED", label: "Delivered" },
  { id: "CANCELLED", label: "Cancelled" },
  { id: "ALL", label: "All" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["id"];

function filterByLabel(label: string): StatusFilter {
  return (STATUS_FILTERS.find((f) => f.label === label)?.id ?? "ALL") as StatusFilter;
}

function labelForFilter(id: StatusFilter): string {
  return STATUS_FILTERS.find((f) => f.id === id)?.label ?? "All";
}

function statusPill(status: string): { variant: "brand" | "green" | "orange" | "red" | "gray"; label: string } {
  switch (status) {
    case "PENDING":
      return { variant: "orange", label: "Pending" };
    case "CONFIRMED":
      return { variant: "brand", label: "Confirmed" };
    case "OUT_FOR_DELIVERY":
      return { variant: "brand", label: "Out" };
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

export default function OrdersListScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ status?: string }>();
  const initialFilter: StatusFilter =
    STATUS_FILTERS.find((f) => f.id === params.status)?.id ?? "PENDING";

  const [filter, setFilter] = useState<StatusFilter>(initialFilter);
  const [search, setSearch] = useState("");

  const statusParam = filter === "ALL" ? undefined : filter;
  const { data, isLoading, isFetching, refetch } = useAdminOrders({
    status: statusParam,
    search: search.trim() || undefined,
    limit: 50,
  });

  const orders = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Orders"
        trailing={
          <NavAction
            label="New"
            bold
            onPress={() => router.push("/(operator)/new-order")}
          />
        }
      />

      <SearchBar
        placeholder="Search orders, customers…"
        value={search}
        onChangeText={setSearch}
      />

      <FilterChipRow
        chips={STATUS_FILTERS.map((f) => ({ label: f.label }))}
        value={labelForFilter(filter)}
        onChange={(label) => setFilter(filterByLabel(label))}
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
            <Text style={styles.emptyTitle}>
              {search ? "No orders match your search." : "No orders here."}
            </Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(operator)/new-order")}
            >
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>New order</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} onPress={() => router.push(`/(operator)/orders/${o.id}`)} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function OrderRow({ order, onPress }: { order: AdminOrder; onPress: () => void }) {
  const s = statusPill(order.status);
  const itemCount = order.lineItems?.length ?? 0;
  const customer = order.customer?.businessName ?? "Unknown customer";
  const createdAt = useMemo(() => {
    const d = new Date(order.createdAt);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }, [order.createdAt]);

  return (
    <Pressable style={styles.row} onPress={onPress}>
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
          <Text style={styles.rowSub} numberOfLines={1}>
            {customer} · {itemCount} item{itemCount === 1 ? "" : "s"}
            {createdAt ? ` · ${createdAt}` : ""}
          </Text>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.rowTotal}>{formatCurrency(order.total)}</Text>
        <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 14 },
  emptyTitle: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
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
  row: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
  },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  rowSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  rowFoot: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
