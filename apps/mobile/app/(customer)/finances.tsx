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
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { useBuyerAnalytics } from "../../lib/api/buyer";
import {
  invoiceBreakdownRows,
  maxMonthlySpend,
  monthlySpendFraction,
} from "../../lib/buyer-finances-logic";

function money(n: number | undefined): string {
  return `$${(Number.isFinite(n) ? (n as number) : 0).toFixed(2)}`;
}

const STATUS_COLOR: Record<string, string> = {
  paid: ios.system.greenInk,
  unpaid: ios.system.orangeInk,
  overdue: ios.system.redInk,
};

export default function BuyerFinancesScreen() {
  const router = useRouter();
  const { data, isLoading, isError, isFetching, refetch } = useBuyerAnalytics();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Finances"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
      />

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : isError || !data ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Couldn&apos;t load your finances. Pull to retry.</Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: 16, gap: 14 }}
          refreshControl={<RefreshControl refreshing={isFetching} onRefresh={refetch} />}
        >
          {/* Summary tiles */}
          <View style={styles.tileRow}>
            <Tile label="Total spend" value={money(data.summary.totalSpend)} />
            <Tile
              label="Outstanding"
              value={money(data.summary.unpaidInvoiceTotal)}
              sub={`${data.summary.unpaidInvoiceCount} unpaid`}
              tint={data.summary.unpaidInvoiceTotal > 0 ? ios.system.orangeInk : undefined}
            />
          </View>
          <View style={styles.tileRow}>
            <Tile
              label="Orders"
              value={String(data.summary.totalOrders)}
              sub={`avg ${money(data.summary.avgOrderValue)}`}
            />
            <Tile label="Paid invoices" value={String(data.invoiceBreakdown.paid)} />
          </View>

          {/* Invoice status breakdown — plain % bars, no chart lib */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Invoice status</Text>
            {invoiceBreakdownRows(data.invoiceBreakdown).map((r) => (
              <View key={r.key} style={styles.breakRow}>
                <View style={styles.breakHead}>
                  <Text style={styles.breakLabel}>{r.label}</Text>
                  <Text style={styles.breakCount}>
                    {r.count} · {r.pct}%
                  </Text>
                </View>
                <View style={styles.barTrack}>
                  <View
                    style={[
                      styles.barFill,
                      { width: `${r.pct}%`, backgroundColor: STATUS_COLOR[r.key] },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>

          {/* Monthly spend — a plain list of normalized bars (web uses a chart) */}
          {data.monthlySpend.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Monthly spend</Text>
              {(() => {
                const max = maxMonthlySpend(data.monthlySpend);
                return data.monthlySpend.map((m) => (
                  <View key={m.month} style={styles.monthRow}>
                    <Text style={styles.monthLabel}>{m.month}</Text>
                    <View style={styles.monthBarTrack}>
                      <View
                        style={[
                          styles.monthBarFill,
                          { width: `${Math.round(monthlySpendFraction(m.spend, max) * 100)}%` },
                        ]}
                      />
                    </View>
                    <Text style={styles.monthSpend}>{money(m.spend)}</Text>
                  </View>
                ));
              })()}
            </View>
          ) : null}

          {/* Recent payments */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Recent payments</Text>
            {data.recentPayments.length === 0 ? (
              <Text style={styles.empty}>No payments yet.</Text>
            ) : (
              data.recentPayments.map((p, i) => (
                <View
                  key={`${p.invoiceNumber}-${i}`}
                  style={[
                    styles.payRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.payInvoice} numberOfLines={1}>
                      {p.invoiceNumber || "Payment"}
                    </Text>
                    <Text style={styles.paySub}>
                      {new Date(p.date).toLocaleDateString()} · {p.method}
                    </Text>
                  </View>
                  <Text style={styles.payAmount}>{money(p.amount)}</Text>
                </View>
              ))
            )}
          </View>
          {/* Cross-link to the dedicated Payments screen (wallet/history/statement) */}
          <Pressable style={styles.crossLink} onPress={() => router.push("/(customer)/payments")}>
            <View style={styles.crossLinkIcon}>
              <Ionicons name="card-outline" size={16} color={ios.system.greenInk} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.crossLinkTitle}>All payments &amp; statements</Text>
              <Text style={styles.crossLinkSub}>Wallet, payment history, monthly statement</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
          </Pressable>

          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Tile({
  label,
  value,
  sub,
  tint,
}: {
  label: string;
  value: string;
  sub?: string;
  tint?: string;
}) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, tint ? { color: tint } : null]}>{value}</Text>
      {sub ? <Text style={styles.tileSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, padding: 40, alignItems: "center", justifyContent: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  tileRow: { flexDirection: "row", gap: 12 },
  tile: { flex: 1, backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  tileLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  tileValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.5,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  tileSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 10 },
  breakRow: { marginBottom: 10 },
  breakHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  breakLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  breakCount: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: ios.fill3, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4 },
  monthRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 5 },
  monthLabel: { width: 64, fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  monthBarTrack: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: ios.fill3,
    overflow: "hidden",
  },
  monthBarFill: { height: 8, borderRadius: 4, backgroundColor: ios.brand },
  monthSpend: {
    width: 78,
    textAlign: "right",
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  payRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  payInvoice: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  paySub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  payAmount: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
  crossLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
  },
  crossLinkIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: ios.system.greenWash,
    alignItems: "center",
    justifyContent: "center",
  },
  crossLinkTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  crossLinkSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
});
