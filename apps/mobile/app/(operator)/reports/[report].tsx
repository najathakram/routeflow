import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { KpiCard, NavBackButton, NavBar, SegmentedControl } from "@routeflow/ui/mobile/ios";
import {
  useArAgingInvoices,
  useCashFlow,
  useProfitAndLoss,
  useSalesByCustomer,
  useSalesByItem,
} from "../../../lib/api/reports";
import {
  arAgingColumns,
  arAgingCustomerRows,
  AR_INTERVALS,
  DATE_PRESETS,
  dateRangeForPreset,
  DEFAULT_AR_INTERVAL,
  DEFAULT_PRESET,
  reportMetaById,
  type DateRangePreset,
} from "../../../lib/reports-logic";

/** Grouped-thousands currency. All values are server-computed — never derived here. */
function fmtCurrency(n: number | undefined): string {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  const neg = v < 0;
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${grouped}.${dec}`;
}

export default function ReportDetailScreen() {
  const router = useRouter();
  const { report } = useLocalSearchParams<{ report: string }>();
  const meta = reportMetaById(report);

  const [preset, setPreset] = useState<DateRangePreset>(DEFAULT_PRESET);
  const [interval, setInterval] = useState<number>(DEFAULT_AR_INTERVAL);
  const { from, to } = useMemo(() => dateRangeForPreset(preset, new Date()), [preset]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={meta?.label ?? "Report"}
        leading={<NavBackButton label="Reports" onPress={() => router.back()} />}
      />
      {!meta ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Report not found.</Text>
        </View>
      ) : (
        <>
          <View style={styles.controls}>
            {meta.control === "date" ? (
              <SegmentedControl
                items={DATE_PRESETS}
                value={preset}
                onChange={(v) => setPreset(v as DateRangePreset)}
              />
            ) : (
              <SegmentedControl
                items={AR_INTERVALS.map((d) => `${d} days`)}
                value={`${interval} days`}
                onChange={(v) => setInterval(parseInt(v, 10) || DEFAULT_AR_INTERVAL)}
              />
            )}
          </View>
          {report === "profit-loss" ? (
            <ProfitLossBody from={from} to={to} />
          ) : report === "cashflow" ? (
            <CashFlowBody from={from} to={to} />
          ) : report === "sales-by-customer" ? (
            <SalesByCustomerBody from={from} to={to} />
          ) : report === "sales-by-item" ? (
            <SalesByItemBody from={from} to={to} />
          ) : (
            <ArAgingBody interval={interval} />
          )}
        </>
      )}
    </SafeAreaView>
  );
}

// ─── Shared shells ──────────────────────────────────────────────────────────────

function Body({
  isLoading,
  isFetching,
  isError,
  refetch,
  isEmpty,
  emptyText,
  children,
}: {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
  isEmpty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />}
    >
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Couldn&apos;t load this report. Pull to retry.</Text>
        </View>
      ) : isEmpty ? (
        <View style={styles.center}>
          <Text style={styles.empty}>{emptyText}</Text>
        </View>
      ) : (
        children
      )}
    </ScrollView>
  );
}

/** A right-aligned label/value table row. */
function TableRow({
  label,
  sub,
  value,
  bold,
  first,
}: {
  label: string;
  sub?: string;
  value: string;
  bold?: boolean;
  first?: boolean;
}) {
  return (
    <View style={[styles.tRow, !first && styles.tRowBorder]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.tLabel, bold && styles.tBold]} numberOfLines={1}>
          {label}
        </Text>
        {sub ? (
          <Text style={styles.tSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.tValue, bold && styles.tBold]}>{value}</Text>
    </View>
  );
}

// ─── Profit & Loss ──────────────────────────────────────────────────────────────

function ProfitLossBody({ from, to }: { from: string; to: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useProfitAndLoss(from, to);
  const d = data;
  const cats = Object.entries(d?.expensesByCategory ?? {});
  return (
    <Body
      isLoading={isLoading}
      isFetching={isFetching}
      isError={isError}
      refetch={refetch}
      isEmpty={!d}
      emptyText="No data for this period."
    >
      <View style={styles.kpiRow}>
        <KpiCard value={fmtCurrency(d?.revenue)} label="Revenue" />
        <KpiCard value={fmtCurrency(d?.operatingExpenses)} label="Expenses" />
        <KpiCard
          value={fmtCurrency(d?.netProfit)}
          label="Net profit"
          highlighted={(d?.netProfit ?? 0) >= 0}
        />
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Profit &amp; Loss</Text>
        <TableRow label="Revenue" value={fmtCurrency(d?.revenue)} bold first />
        <TableRow label="Cost of Goods Sold" value={fmtCurrency(d?.cogs)} />
        <TableRow label="Gross Profit" value={fmtCurrency(d?.grossProfit)} bold />
        {cats.map(([cat, amt]) => (
          <TableRow key={cat} label={cat} value={fmtCurrency(amt)} />
        ))}
        <TableRow label="Operating Expenses" value={fmtCurrency(d?.operatingExpenses)} bold />
        <TableRow label="Net Profit" value={fmtCurrency(d?.netProfit)} bold />
      </View>
    </Body>
  );
}

// ─── Cash Flow ──────────────────────────────────────────────────────────────────

function CashFlowBody({ from, to }: { from: string; to: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useCashFlow(from, to);
  const d = data;
  return (
    <Body
      isLoading={isLoading}
      isFetching={isFetching}
      isError={isError}
      refetch={refetch}
      isEmpty={!d}
      emptyText="No data for this period."
    >
      <View style={styles.kpiRow}>
        <KpiCard value={fmtCurrency(d?.totalIn)} label="Cash in" />
        <KpiCard value={fmtCurrency(d?.totalOut)} label="Cash out" />
      </View>
      <View style={styles.kpiRow}>
        <KpiCard
          value={fmtCurrency(d?.netCashFlow)}
          label="Net cash flow"
          highlighted={(d?.netCashFlow ?? 0) >= 0}
        />
      </View>
    </Body>
  );
}

// ─── Sales by Customer ──────────────────────────────────────────────────────────

function SalesByCustomerBody({ from, to }: { from: string; to: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useSalesByCustomer(from, to);
  const rows = data?.data ?? [];
  const total = rows.reduce((s, r) => s + r.salesAmount, 0);
  return (
    <Body
      isLoading={isLoading}
      isFetching={isFetching}
      isError={isError}
      refetch={refetch}
      isEmpty={rows.length === 0}
      emptyText="No sales in this period."
    >
      <View style={styles.card}>
        {rows.map((r, i) => (
          <TableRow
            key={r.customerId}
            label={r.businessName}
            sub={`${r.invoiceCount} invoice${r.invoiceCount === 1 ? "" : "s"}`}
            value={fmtCurrency(r.salesAmount)}
            first={i === 0}
          />
        ))}
        <TableRow label="Total" value={fmtCurrency(total)} bold />
      </View>
    </Body>
  );
}

// ─── Sales by Item ──────────────────────────────────────────────────────────────

function SalesByItemBody({ from, to }: { from: string; to: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useSalesByItem(from, to);
  const rows = data?.data ?? [];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <Body
      isLoading={isLoading}
      isFetching={isFetching}
      isError={isError}
      refetch={refetch}
      isEmpty={rows.length === 0}
      emptyText="No sales in this period."
    >
      <View style={styles.card}>
        {rows.map((r, i) => (
          <TableRow
            key={r.productId ?? `desc:${r.name}:${i}`}
            label={r.name}
            sub={`Qty ${Number(r.qty).toFixed(2)}`}
            value={fmtCurrency(r.amount)}
            first={i === 0}
          />
        ))}
        <TableRow label="Total" value={fmtCurrency(total)} bold />
      </View>
    </Body>
  );
}

// ─── AR Aging ───────────────────────────────────────────────────────────────────

function ArAgingBody({ interval }: { interval: number }) {
  const { data, isLoading, isFetching, isError, refetch } = useArAgingInvoices(interval);
  const cols = arAgingColumns(interval);
  const customers = arAgingCustomerRows(data?.buckets);
  const totals = data?.totals;

  return (
    <Body
      isLoading={isLoading}
      isFetching={isFetching}
      isError={isError}
      refetch={refetch}
      isEmpty={customers.length === 0}
      emptyText="No outstanding invoices."
    >
      {/* Bucket totals */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Outstanding by age</Text>
        {cols.map((c, i) => (
          <TableRow
            key={c.key}
            label={c.label === "Current" ? "Current" : `${c.label} days`}
            value={fmtCurrency(totals?.[c.key] ?? 0)}
            first={i === 0}
          />
        ))}
        <TableRow label="Total" value={fmtCurrency(totals?.total ?? 0)} bold />
      </View>

      {/* Per-customer breakdown */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>By customer</Text>
        {customers.map((cust, i) => {
          const parts = cols
            .filter((c) => (cust.buckets[c.key] ?? 0) > 0)
            .map((c) => `${c.label}: ${fmtCurrency(cust.buckets[c.key])}`)
            .join("  ·  ");
          return (
            <TableRow
              key={cust.customerId}
              label={cust.name}
              sub={parts || undefined}
              value={fmtCurrency(cust.total)}
              first={i === 0}
            />
          );
        })}
      </View>
    </Body>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  controls: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  kpiRow: { flexDirection: "row", gap: 12 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 4 },
  tRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  tRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ios.separator },
  tLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  tSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  tValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  tBold: { fontFamily: "Inter_700Bold", color: ios.label },
});
