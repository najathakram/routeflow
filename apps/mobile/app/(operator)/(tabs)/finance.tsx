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
import { KpiCard, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useVendorBills,
  type VendorBill,
  type VendorBillStatus,
} from "../../../lib/api/vendor-bills";

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function billPill(status: VendorBillStatus) {
  switch (status) {
    case "DRAFT":
      return { variant: "gray" as const, label: "Draft" };
    case "RECEIVED":
      return { variant: "orange" as const, label: "Received" };
    case "PARTIAL":
      return { variant: "orange" as const, label: "Partial" };
    case "FULL":
      return { variant: "green" as const, label: "Paid" };
    case "VOID":
      return { variant: "gray" as const, label: "Void" };
  }
}

export default function FinanceScreen() {
  const router = useRouter();
  const { data, isLoading, isFetching, refetch } = useVendorBills({ limit: 10 });
  const bills = data?.data ?? [];

  const unpaidCount = bills.filter((b) => b.status === "RECEIVED" || b.status === "PARTIAL").length;
  const unpaidTotal = bills
    .filter((b) => b.status === "RECEIVED" || b.status === "PARTIAL")
    .reduce((sum, b) => sum + Number(b.totalOwed ?? 0), 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Finance"
        leading={<Text style={styles.eyebrow}>VENDOR BILLS & EXPENSES</Text>}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {/* Primary CTA */}
        <View style={styles.ctaRow}>
          <Pressable
            style={[styles.ctaBtn, { backgroundColor: ios.brand }]}
            onPress={() => router.push("/(operator)/vendor-bills/scan")}
          >
            <Ionicons name="scan-outline" size={20} color="#fff" />
            <Text style={styles.ctaBtnText}>Scan Invoice</Text>
          </Pressable>
          <Pressable
            style={[
              styles.ctaBtn,
              {
                backgroundColor: ios.bgElev,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: ios.separator,
              },
            ]}
            onPress={() => router.push("/(operator)/vendor-bills/new")}
          >
            <Ionicons name="add" size={20} color={ios.label} />
            <Text style={[styles.ctaBtnText, { color: ios.label }]}>New Bill</Text>
          </Pressable>
        </View>

        {/* KPIs */}
        <View style={styles.kpiRow}>
          <KpiCard
            icon={<Ionicons name="receipt-outline" size={18} color={ios.system.orangeInk} />}
            iconBg={ios.system.orangeWash}
            value={String(unpaidCount)}
            label="Unpaid bills"
          />
          <KpiCard
            icon={<Ionicons name="cash-outline" size={18} color={ios.system.redInk} />}
            iconBg={ios.system.redWash}
            value={formatCurrency(unpaidTotal)}
            label="Amount owing"
          />
        </View>

        {/* Quick links */}
        <View style={styles.quickRow}>
          <QuickLink
            icon="document-text-outline"
            label="All bills"
            color={ios.brand}
            bg={ios.brandWash}
            onPress={() => router.push("/(operator)/vendor-bills")}
          />
          <QuickLink
            icon="card-outline"
            label="Expenses"
            color={ios.system.purpleInk}
            bg={ios.system.purpleWash}
            onPress={() => router.push("/(operator)/expenses")}
          />
          <QuickLink
            icon="people-outline"
            label="Suppliers"
            color={ios.system.greenInk}
            bg={ios.system.greenWash}
            onPress={() => router.push("/(operator)/suppliers")}
          />
        </View>

        {/* Recent bills */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>Recent bills</Text>
          <Pressable onPress={() => router.push("/(operator)/vendor-bills")}>
            <Text style={styles.seeAll}>See all</Text>
          </Pressable>
        </View>

        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : bills.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No vendor bills yet. Scan an invoice to get started.</Text>
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
    <Pressable style={styles.billRow} onPress={onPress}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.billTitle} numberOfLines={1}>
          {bill.supplier?.name ?? "Supplier"} {bill.billNumber ? `· ${bill.billNumber}` : ""}
        </Text>
        <Text style={styles.billSub} numberOfLines={1}>
          {bill.billDate
            ? new Date(bill.billDate).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })
            : "No date"}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        <Text style={styles.billTotal}>{formatCurrency(bill.totalOwed)}</Text>
        <Pill variant={p.variant} small>
          {p.label}
        </Pill>
      </View>
    </Pressable>
  );
}

function QuickLink({
  icon,
  label,
  color,
  bg,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  bg: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.quickBtn, { backgroundColor: bg }]} onPress={onPress}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.quickBtnLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  eyebrow: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2, letterSpacing: 0.4 },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  ctaRow: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  ctaBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  ctaBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  kpiRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, marginTop: 16 },
  quickRow: { flexDirection: "row", gap: 10, paddingHorizontal: 16, marginTop: 16 },
  quickBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
  },
  quickBtnLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  seeAll: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  billRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  billTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  billSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  billTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
