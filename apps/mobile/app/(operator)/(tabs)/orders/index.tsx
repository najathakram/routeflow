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
import { FilterChipRow, NavAction, NavBar, Pill, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminCustomer, useAdminOrders, type AdminOrder } from "../../../../lib/api/admin";
import { useProduct } from "../../../../lib/api/products";
import { useDeliveryAccess } from "../../../../lib/api/addons";
import { useTripDraftStore } from "../../../../lib/trip-draft";
import { DraftStrip } from "../../../../components/DraftStrip";
import {
  customerFilterChipLabel,
  productFilterChipLabel,
  resolveCustomerIdParam,
  resolveProductIdParam,
} from "../../../../lib/customer-order-filter";

// Default filter is "All" so operators land on the full picture rather than
// only Pending. Reordered to surface All first, then statuses left-to-right
// in delivery-flow order.
const STATUS_FILTERS = [
  { id: "ALL", label: "All" },
  { id: "DRAFT", label: "Draft" },
  { id: "PENDING", label: "Pending" },
  { id: "CONFIRMED", label: "Confirmed" },
  { id: "OUT_FOR_DELIVERY", label: "Out" },
  { id: "DELIVERED", label: "Delivered" },
  { id: "CANCELLED", label: "Cancelled" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["id"];

function filterByLabel(label: string): StatusFilter {
  return (STATUS_FILTERS.find((f) => f.label === label)?.id ?? "ALL") as StatusFilter;
}

function labelForFilter(id: StatusFilter): string {
  return STATUS_FILTERS.find((f) => f.id === id)?.label ?? "All";
}

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
  const params = useLocalSearchParams<{
    status?: string;
    customerId?: string;
    productId?: string;
  }>();
  const initialFilter: StatusFilter =
    STATUS_FILTERS.find((f) => f.id === params.status)?.id ?? "ALL";

  const [filter, setFilter] = useState<StatusFilter>(initialFilter);
  const [search, setSearch] = useState("");
  // A3 cross-link: the customer detail screen's "View orders" pushes ?customerId=,
  // which used to be dropped here — every operator saw ALL orders instead of just
  // this customer's. Seeded once from the route param; dismissing the chip clears
  // both this state and the param so the filter can't silently reappear on remount.
  const [customerFilter, setCustomerFilter] = useState<string | null>(() =>
    resolveCustomerIdParam(params.customerId),
  );
  // PR-B: same pattern for the product detail Sales card's "View orders" link
  // (?productId=). Independent of the customer filter — both can be seeded and
  // dismissed on their own; neither clearing the other.
  const [productFilter, setProductFilter] = useState<string | null>(() =>
    resolveProductIdParam(params.productId),
  );

  // Ad-hoc trips (order delivery, owner split 2026-08-25): multi-select is a
  // hide-only affordance (the underlying POST /trips endpoint is already
  // OPERATOR-role-gated server-side), so it keys off `enabled` rather than
  // `resolved` — the same composed access hook (operator)/_layout.tsx uses
  // to gate the /trips route itself (DELIVERY_SECTIONS).
  const { enabled: deliveryEnabled } = useDeliveryAccess();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const setTripOrderIds = useTripDraftStore((s) => s.setOrderIds);

  const toggleSelectMode = () => {
    setSelectMode((v) => !v);
    setSelected(new Set());
  };

  const toggleSelected = (orderId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const handlePlanTrip = () => {
    if (selected.size === 0) return;
    setTripOrderIds([...selected]);
    setSelectMode(false);
    setSelected(new Set());
    router.push("/(operator)/trips/new" as any);
  };

  const statusParam = filter === "ALL" ? undefined : filter;
  const { data, isLoading, isFetching, refetch } = useAdminOrders({
    status: statusParam,
    search: search.trim() || undefined,
    customerId: customerFilter ?? undefined,
    productId: productFilter ?? undefined,
    limit: 50,
  });
  const { data: filteredCustomer } = useAdminCustomer(customerFilter ?? "");
  const { data: filteredProduct } = useProduct(productFilter ?? "");

  const clearCustomerFilter = () => {
    setCustomerFilter(null);
    router.setParams({ customerId: undefined });
  };

  const clearProductFilter = () => {
    setProductFilter(null);
    router.setParams({ productId: undefined });
  };

  const orders = data?.data ?? [];

  // O-6: detect customers with multiple PENDING orders so the operator can see duplicates at a glance
  const pendingCountByCustomer = useMemo(() => {
    if (filter !== "PENDING" && filter !== "ALL") return new Map<string, number>();
    const map = new Map<string, number>();
    for (const o of orders) {
      if (o.status === "PENDING" && o.customer?.id) {
        map.set(o.customer?.id, (map.get(o.customer?.id) ?? 0) + 1);
      }
    }
    return map;
  }, [orders, filter]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Orders"
        leading={
          deliveryEnabled ? (
            <NavAction label={selectMode ? "Done" : "Select"} onPress={toggleSelectMode} />
          ) : undefined
        }
        trailing={
          <NavAction label="New" bold onPress={() => router.push("/(operator)/new-order")} />
        }
      />

      <SearchBar placeholder="Search orders, customers…" value={search} onChangeText={setSearch} />

      {customerFilter ? (
        <Pressable style={styles.activeFilterBanner} onPress={clearCustomerFilter}>
          <Ionicons name="person-outline" size={14} color={ios.brand} />
          <Text style={styles.activeFilterText} numberOfLines={1}>
            {customerFilterChipLabel(filteredCustomer?.businessName)}
          </Text>
          <Ionicons name="close" size={14} color={ios.brand} />
        </Pressable>
      ) : null}

      {/* PR-B: independent of the customer chip above — both can show at once,
          each dismissing only its own filter. */}
      {productFilter ? (
        <Pressable style={styles.activeFilterBanner} onPress={clearProductFilter}>
          <Ionicons name="cube-outline" size={14} color={ios.brand} />
          <Text style={styles.activeFilterText} numberOfLines={1}>
            {productFilterChipLabel(filteredProduct?.name)}
          </Text>
          <Ionicons name="close" size={14} color={ios.brand} />
        </Pressable>
      ) : null}

      <FilterChipRow
        chips={STATUS_FILTERS.map((f) => ({ label: f.label }))}
        value={labelForFilter(filter)}
        onChange={(label) => setFilter(filterByLabel(label))}
      />

      {/* Parked drafts (PR-3) — renders nothing when there are none. */}
      <DraftStrip />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          { flexGrow: 1 },
          // Bottom content inset so the last row is never hidden behind the
          // floating bulk bar (which sits above this ScrollView, itself
          // already above the operator tab bar — see the bulk bar's own
          // comment below).
          selectMode && { paddingBottom: 96 },
        ]}
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
              <OrderRow
                key={o.id}
                order={o}
                duplicateCount={
                  o.customer?.id ? (pendingCountByCustomer.get(o.customer?.id) ?? 0) : 0
                }
                selectMode={selectMode}
                selected={selected.has(o.id)}
                onPress={() =>
                  selectMode ? toggleSelected(o.id) : router.push(`/(operator)/orders/${o.id}`)
                }
              />
            ))}
          </View>
        )}
      </ScrollView>

      {/* Bottom bulk bar — an in-flow sibling below the ScrollView (not
          absolutely positioned), so it already sits above the persistent
          operator tab bar rendered in (operator)/_layout.tsx: that bar is
          itself a flex sibling below this whole screen's <Stack>, so this
          screen's own bounds already end before it. Design directive: 44pt
          target, no double-submit. */}
      {selectMode ? (
        <View style={styles.bulkBar}>
          <Pressable
            style={[styles.bulkBtn, selected.size === 0 && styles.bulkBtnDisabled]}
            disabled={selected.size === 0}
            onPress={handlePlanTrip}
          >
            <Ionicons name="navigate-outline" size={18} color="#fff" />
            <Text style={styles.bulkBtnText}>{selected.size} selected · Plan trip</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function OrderRow({
  order,
  duplicateCount = 0,
  selectMode = false,
  selected = false,
  onPress,
}: {
  order: AdminOrder;
  duplicateCount?: number;
  selectMode?: boolean;
  selected?: boolean;
  onPress: () => void;
}) {
  const s = statusPill(order.status);
  const itemCount = order.lineItems?.length ?? 0;
  const customer = order.customer?.businessName ?? "Unknown customer";
  const createdAt = useMemo(() => {
    const d = new Date(order.createdAt);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }, [order.createdAt]);

  return (
    // The full row is the hit area for both navigation and select-mode
    // toggling — no separate small checkbox-only pressable.
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        {selectMode ? (
          <Ionicons
            name={selected ? "checkmark-circle" : "ellipse-outline"}
            size={22}
            color={selected ? ios.brand : ios.gray[3]}
          />
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {order.orderNumber}
            </Text>
            {order.urgent ? (
              <View style={styles.urgentBadge}>
                <Ionicons name="flash" size={10} color="#fff" />
                <Text style={styles.urgentText}>URGENT</Text>
              </View>
            ) : null}
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              marginTop: 2,
              flexWrap: "wrap",
            }}
          >
            <Text style={styles.rowSub} numberOfLines={1}>
              {customer} · {itemCount} item{itemCount === 1 ? "" : "s"}
              {createdAt ? ` · ${createdAt}` : ""}
            </Text>
            {duplicateCount > 1 ? (
              <View style={styles.dupeBadge}>
                <Ionicons name="copy-outline" size={10} color={ios.system.orangeInk} />
                <Text style={styles.dupeText}>{duplicateCount} pending</Text>
              </View>
            ) : null}
          </View>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.rowTotal}>{formatCurrency(order.total)}</Text>
        {selectMode ? null : <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", justifyContent: "center", gap: 14, flex: 1 },
  emptyTitle: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  activeFilterBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
  },
  activeFilterText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
  },
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
  urgentBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: ios.system.red,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  urgentText: { fontSize: 10, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.3 },
  dupeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  dupeText: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: ios.system.orangeInk },
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
  bulkBar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  bulkBtn: {
    minHeight: ios.rowMinH,
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
  },
  bulkBtnDisabled: { opacity: 0.4 },
  bulkBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
