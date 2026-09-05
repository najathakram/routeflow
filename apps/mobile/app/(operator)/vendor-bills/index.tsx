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
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FilterChipRow, NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useVendorBills,
  billNeedsMapping,
  type VendorBill,
  type VendorBillStatus,
} from "../../../lib/api/vendor-bills";
import { vendorBillPillFor as billPill } from "../../../lib/vendor-bill-logic";
import { fmtCalendarDate } from "../../../lib/format-date";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "RECEIVED", label: "Unpaid" },
  { id: "PAID", label: "Paid" },
  { id: "DRAFT", label: "Draft" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function VendorBillsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("ALL");

  const statusParam = filter === "ALL" ? undefined : (filter as VendorBillStatus | undefined);

  const { data, isLoading, isFetching, refetch } = useVendorBills({
    status: statusParam,
    limit: 50,
  });
  const bills = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Vendor Bills"
        leading={<NavBackButton label="Finance" onPress={() => router.back()} />}
        trailing={
          <View style={{ flexDirection: "row", gap: 8 }}>
            <NavAction label="Scan" onPress={() => router.push("/(operator)/vendor-bills/scan")} />
            <NavAction
              label="New"
              bold
              onPress={() => router.push("/(operator)/vendor-bills/new")}
            />
          </View>
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
        ) : bills.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No bills yet.</Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(operator)/vendor-bills/scan")}
            >
              <Ionicons name="scan-outline" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Scan invoice</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 32 }}>
            {bills.map((b) => (
              <BillRow
                key={b.id}
                bill={b}
                onPress={() => router.push(`/(operator)/vendor-bills/${b.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function BillRow({ bill, onPress }: { bill: VendorBill; onPress: () => void }) {
  const p = billPill(bill.status);
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {bill.supplier?.name ?? "Unknown supplier"}
            {bill.billNumber ? ` · ${bill.billNumber}` : ""}
          </Text>
          {billNeedsMapping(bill) ? (
            <Text style={styles.needsItems} numberOfLines={1}>
              Needs items — won’t update costs
            </Text>
          ) : null}
          <Text style={styles.rowSub} numberOfLines={1}>
            {bill.billDate ? fmtCalendarDate(bill.billDate, "short") : "No date"}
            {bill.dueDate ? ` · Due ${fmtCalendarDate(bill.dueDate, "monthDay")}` : ""}
          </Text>
        </View>
        <Pill variant={p.variant} dot>
          {p.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.rowTotal}>{formatCurrency(bill.totalOwed)}</Text>
        <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 14 },
  empty: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  needsItems: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#B45309", marginTop: 2 },
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
  row: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
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
