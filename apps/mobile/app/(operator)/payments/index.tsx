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
import { FilterChipRow, KpiCard, NavBar, Pill, SearchBar } from "@routeflow/ui/mobile/ios";
import { Ionicons } from "@expo/vector-icons";
import { useInvoicePayments, type AllPayment } from "../../../lib/api/payments";
import { paymentMethodPill, paymentStatusPill } from "../../../lib/payments-logic";
import { checkBadgeFor } from "../../../lib/check-badge";
import { ALL_PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "../../../lib/payment-methods";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "PAID", label: "Paid" },
  { id: "DRAFT", label: "Draft" },
  { id: "VOID", label: "Void" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

// Method filter — the server takes one exact enum value (`method=`). Filters cover
// every method, including the display-only CREDIT_NOTE / ADVANCE.
const METHOD_FILTERS = [
  { id: "ALL" as const, label: "Any method" },
  ...ALL_PAYMENT_METHODS.map((id) => ({ id, label: PAYMENT_METHOD_LABELS[id] })),
];

type MethodFilterId = (typeof METHOD_FILTERS)[number]["id"];

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

export default function PaymentsListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("ALL");
  const [methodFilter, setMethodFilter] = useState<MethodFilterId>("ALL");
  // "Load more" grows the fetch window (server clamps at 1000); the list is a
  // plain query, so growing the limit re-fetches the full window — fine at
  // these sizes and it keeps pull-to-refresh semantics trivial.
  const [limit, setLimit] = useState(50);
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, refetch, isError } = useInvoicePayments({
    status: filter === "ALL" ? undefined : filter,
    method: methodFilter === "ALL" ? undefined : methodFilter,
    search: search.trim() || undefined,
    limit,
  });
  const payments = data?.data ?? [];
  const summary = data?.summary;
  const total = data?.meta?.total ?? 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Payments"
        trailing={
          <Pressable
            onPress={() => router.push("/(operator)/payments/record" as any)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Record payment"
          >
            <Ionicons name="add-circle-outline" size={24} color={ios.brand} />
          </Pressable>
        }
      />
      <SearchBar
        placeholder="Payment #, reference or customer…"
        value={search}
        onChangeText={setSearch}
      />
      {summary ? (
        <View style={styles.kpiRow}>
          <KpiCard value={fmtCurrency(summary.totalReceived)} label="Received" />
          <KpiCard value={String(summary.count)} label="Payments" />
          <KpiCard
            value={fmtCurrency(summary.advanceBalance)}
            label="Advance"
            highlighted={summary.advanceBalance > 0}
          />
        </View>
      ) : null}
      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) =>
          setFilter((FILTERS.find((f) => f.label === label)?.id as FilterId) ?? "ALL")
        }
      />
      <FilterChipRow
        chips={METHOD_FILTERS.map((f) => ({ label: f.label }))}
        value={METHOD_FILTERS.find((f) => f.id === methodFilter)?.label ?? "Any method"}
        onChange={(label) =>
          setMethodFilter(
            (METHOD_FILTERS.find((f) => f.label === label)?.id as MethodFilterId) ?? "ALL",
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
        ) : isError ? (
          <View style={styles.center}>
            <Text style={styles.empty}>Couldn&apos;t load payments. Pull to retry.</Text>
          </View>
        ) : payments.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>{search ? "No payments match." : "No payments yet."}</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {payments.map((p) => (
              <Row
                key={p.id}
                payment={p}
                onPress={() => router.push(`/(operator)/payments/${p.id}`)}
              />
            ))}
            {total > payments.length ? (
              <Pressable
                style={styles.loadMore}
                onPress={() => setLimit((l) => Math.min(l + 50, 1000))}
                disabled={isFetching}
              >
                <Text style={styles.loadMoreText}>
                  {isFetching ? "Loading…" : `Load more (${payments.length} of ${total})`}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ payment, onPress }: { payment: AllPayment; onPress: () => void }) {
  const m = paymentMethodPill(payment.method);
  const s = paymentStatusPill(payment.status);
  const isVoid = payment.status === "VOID";
  // Check-lifecycle badge (null for non-checks and manually-voided checks).
  const check = checkBadgeFor(payment);
  return (
    <Pressable style={[styles.row, isVoid && { opacity: 0.55 }]} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {payment.paymentNumber ?? "Payment"}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {payment.invoice.customer?.businessName ?? "Customer"}
          </Text>
        </View>
        <View style={styles.pills}>
          {check ? (
            <Pill variant={check.variant} dot small>
              {check.label}
            </Pill>
          ) : (
            <Pill variant={m.variant} dot small>
              {m.label}
            </Pill>
          )}
          {isVoid ? (
            <Pill variant={s.variant} dot small>
              {s.label}
            </Pill>
          ) : null}
        </View>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.amount}>{fmtCurrency(payment.amount)}</Text>
        <Text style={styles.footText} numberOfLines={1}>
          Paid {new Date(payment.paidAt ?? payment.createdAt).toLocaleDateString()} · Inv{" "}
          {payment.invoice.invoiceNumber}
        </Text>
      </View>
      {payment.settledAt ? (
        <Text style={styles.bankDate} numberOfLines={1}>
          Bank date {new Date(payment.settledAt).toLocaleDateString()}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  kpiRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  pills: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  rowFoot: { marginTop: 10, flexDirection: "row", alignItems: "baseline", gap: 6 },
  amount: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  footText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  bankDate: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 3 },
  loadMore: { paddingVertical: 12, alignItems: "center" },
  loadMoreText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
