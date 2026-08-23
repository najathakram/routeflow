import { useState } from "react";
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
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FilterChipRow, NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useOpenPurchaseOrders,
  usePurchaseOrders,
  type POStatus,
  type PurchaseOrder,
} from "../../../lib/api/purchase-orders";
import { fmtCalendarDate } from "../../../lib/format-date";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "OPEN", label: "Open" },
  { id: "RECEIVED", label: "Received" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function statusPill(status: POStatus): {
  variant: "brand" | "green" | "orange" | "red" | "gray";
  label: string;
} {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "SENT":
      return { variant: "orange", label: "Sent" };
    case "PARTIALLY_RECEIVED":
      return { variant: "brand", label: "Partial" };
    case "RECEIVED":
      return { variant: "green", label: "Received" };
    case "CLOSED":
      return { variant: "gray", label: "Closed" };
    default:
      return { variant: "gray", label: status };
  }
}

function fmtCurrency(n: number | undefined): string {
  return `$${(Number.isFinite(n ?? 0) ? (n ?? 0) : 0).toFixed(2)}`;
}

export default function PurchaseOrdersListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("ALL");

  const allQuery = usePurchaseOrders(filter === "RECEIVED" ? "RECEIVED" : undefined);
  const openQuery = useOpenPurchaseOrders();

  const activeQuery = filter === "OPEN" ? openQuery : allQuery;
  const { data, isLoading, isFetching, refetch } = activeQuery;
  const orders = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Purchase Orders"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="+ New"
            bold
            onPress={() => router.push("/(operator)/purchase-orders/new")}
          />
        }
      />
      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) =>
          setFilter((FILTERS.find((f) => f.label === label)?.id as FilterId) ?? "ALL")
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
            <Text style={styles.empty}>No purchase orders</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {orders.map((po) => (
              <PORow
                key={po.id}
                po={po}
                onPress={() => router.push(`/(operator)/purchase-orders/${po.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PORow({ po, onPress }: { po: PurchaseOrder; onPress: () => void }) {
  const s = statusPill(po.status);
  const expectedLabel = po.expectedDate ? `Expected ${fmtCalendarDate(po.expectedDate)}` : null;

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {po.poNumber}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {po.supplier?.name ?? "Supplier"}
            {expectedLabel ? ` · ${expectedLabel}` : ""}
          </Text>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.total}>
          {fmtCurrency(
            po.totalAmount ??
              po.items.reduce((s, i) => s + Number(i.qtyOrdered) * Number(i.unitCost), 0),
          )}
        </Text>
        <Text style={styles.itemCount}>
          {po.items.length} item{po.items.length !== 1 ? "s" : ""}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  list: { paddingHorizontal: 16, gap: 8, paddingBottom: 24 },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  sub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  rowFoot: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  total: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  itemCount: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
});
