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
import { useAdminInvoices, type AdminInvoice } from "../../../../lib/api/admin";
import { fmtCalendarDate } from "../../../../lib/format-date";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "DRAFT", label: "Draft" },
  { id: "SENT", label: "Sent" },
  { id: "OVERDUE", label: "Overdue" },
  { id: "PAID", label: "Paid" },
  { id: "VOID", label: "Voided" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function statusPill(status: string): {
  variant: "brand" | "green" | "orange" | "red" | "gray";
  label: string;
} {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "SENT":
      return { variant: "brand", label: "Sent" };
    case "VIEWED":
      return { variant: "brand", label: "Viewed" };
    case "PARTIAL":
      return { variant: "orange", label: "Partial" };
    case "PAID":
      return { variant: "green", label: "Paid" };
    case "OVERDUE":
      return { variant: "red", label: "Overdue" };
    case "VOID":
      return { variant: "gray", label: "Voided" };
    default:
      return { variant: "gray", label: status };
  }
}

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function InvoicesListScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ status?: string }>();
  const initialFilter: FilterId =
    (FILTERS.find((f) => f.id === params.status)?.id as FilterId) ?? "ALL";
  const [filter, setFilter] = useState<FilterId>(initialFilter);
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, refetch } = useAdminInvoices({
    status: filter === "ALL" || filter === "OVERDUE" ? undefined : filter,
    isOverdue: filter === "OVERDUE" ? true : undefined,
    search: search.trim() || undefined,
    limit: 50,
  });
  const invoices = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Invoices"
        trailing={
          <NavAction
            label="New"
            bold
            onPress={() => router.push("/(operator)/invoices/new" as any)}
          />
        }
      />
      <SearchBar placeholder="Search number, customer…" value={search} onChangeText={setSearch} />
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
        ) : invoices.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>{search ? "No invoices match." : "No invoices yet."}</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {invoices.map((inv) => (
              <Row
                key={inv.id}
                inv={inv}
                onPress={() => router.push(`/(operator)/invoices/${inv.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ inv, onPress }: { inv: AdminInvoice; onPress: () => void }) {
  // Treat as overdue if computed isOverdue flag is set, regardless of stored status
  const s = inv.isOverdue ? { variant: "red" as const, label: "Overdue" } : statusPill(inv.status);
  const dueLabel = useMemo(() => {
    if (!inv.dueDate) return "";
    return `Due ${fmtCalendarDate(inv.dueDate)}`;
  }, [inv.dueDate]);
  const balance = inv.balanceDue ?? inv.total;
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {inv.invoiceNumber}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {inv.customer?.businessName ?? "Customer"}
            {dueLabel ? ` · ${dueLabel}` : ""}
          </Text>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.balance}>{fmtCurrency(balance)}</Text>
        <Text style={styles.totalText}>of {fmtCurrency(inv.total)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  rowFoot: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
  },
  balance: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
});
