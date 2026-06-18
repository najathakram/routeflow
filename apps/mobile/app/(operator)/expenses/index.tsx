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
import { useExpenses, type Expense, type ExpenseStatus } from "../../../lib/api/expenses";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "PENDING", label: "Pending" },
  { id: "PAID", label: "Paid" },
  { id: "VOID", label: "Void" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function statusPill(status: ExpenseStatus) {
  switch (status) {
    case "PENDING":
      return { variant: "orange" as const, label: "Pending" };
    case "RECEIVED":
      return { variant: "orange" as const, label: "Received" };
    case "PAID":
      return { variant: "green" as const, label: "Paid" };
    case "VOID":
      return { variant: "gray" as const, label: "Void" };
  }
}

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function ExpensesScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("ALL");

  const statusParam = filter === "ALL" ? undefined : (filter as ExpenseStatus | undefined);

  const { data, isLoading, isFetching, refetch } = useExpenses({
    status: statusParam,
    limit: 50,
  });
  const expenses = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Expenses"
        leading={<NavBackButton label="Finance" onPress={() => router.back()} />}
        trailing={
          <NavAction label="New" bold onPress={() => router.push("/(operator)/expenses/new")} />
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
        ) : expenses.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No expenses yet.</Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(operator)/expenses/new")}
            >
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Add expense</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 32 }}>
            {expenses.map((e) => (
              <ExpenseRow
                key={e.id}
                expense={e}
                onPress={() => router.push(`/(operator)/expenses/${e.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ExpenseRow({ expense, onPress }: { expense: Expense; onPress: () => void }) {
  const p = statusPill(expense.status);
  const dateLabel = new Date(expense.date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {expense.description ?? expense.category?.name ?? "Expense"}
          </Text>
          <Text style={styles.rowSub} numberOfLines={1}>
            {dateLabel}
            {expense.supplier?.name ? ` · ${expense.supplier.name}` : ""}
            {expense.category?.name ? ` · ${expense.category.name}` : ""}
          </Text>
        </View>
        <Pill variant={p.variant} dot>
          {p.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.rowTotal}>{formatCurrency(expense.amount)}</Text>
        <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
      </View>
    </Pressable>
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
