import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill, type PillVariant } from "@routeflow/ui/mobile/ios";
import { fmtCurrency, fmtDate } from "../../../utils/format";
import { useStockCountSessions } from "../../../lib/api/stock-count";
import type { StockCountSessionStatus } from "../../../lib/stock-count-logic";

/**
 * History: every stock-count session (any status), newest first. Tapping a
 * row opens the same `[id]` screen — it renders read-only for
 * COMMITTED/DISCARDED and picks up editing for OPEN/REVIEW.
 *
 * The list endpoint (`GET /inventory/stock-counts`) returns status/date/
 * who/#lines plus a server-computed `netVarianceMoney` scalar (same delta
 * rule as commit — REPLACE = counted − expected, ADD = counted — valued at
 * each product's current averageCost via roundMoney). The raw lines aren't
 * returned here, so this is the only variance figure the list can show
 * without an N+1 fetch per row; the detail screen still shows the full
 * per-line breakdown.
 */
const FILTERS: Array<{ key: StockCountSessionStatus | "ALL"; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "REVIEW", label: "Review" },
  { key: "COMMITTED", label: "Committed" },
  { key: "DISCARDED", label: "Discarded" },
];

const STATUS_PILL: Record<StockCountSessionStatus, PillVariant> = {
  OPEN: "brand",
  REVIEW: "orange",
  COMMITTED: "green",
  DISCARDED: "gray",
};

export default function StockCountsHistoryScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<StockCountSessionStatus | "ALL">("ALL");
  const { data, isLoading } = useStockCountSessions({
    status: filter === "ALL" ? undefined : filter,
    limit: 50,
  });
  const sessions = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Stock counts"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      >
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[styles.filterChipText, filter === f.key && styles.filterChipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 10 }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : sessions.length === 0 ? (
          <Text style={styles.empty}>No stock counts yet.</Text>
        ) : (
          sessions.map((s) => {
            const lineCount = s._count?.lines ?? 0;
            const hasVariance = typeof s.netVarianceMoney === "number";
            return (
              <Pressable
                key={s.id}
                style={styles.card}
                onPress={() => router.push(`/(operator)/products/stock-count/${s.id}` as any)}
              >
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {s.name?.trim() || "Untitled count"}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    {hasVariance ? (
                      <Text
                        style={[
                          styles.varianceText,
                          {
                            color:
                              s.netVarianceMoney! > 0
                                ? ios.system.greenInk
                                : s.netVarianceMoney! < 0
                                  ? ios.system.redInk
                                  : ios.label2,
                          },
                        ]}
                      >
                        {s.netVarianceMoney! > 0 ? "+" : ""}
                        {fmtCurrency(s.netVarianceMoney)}
                      </Text>
                    ) : null}
                    <Pill variant={STATUS_PILL[s.status]} small>
                      {s.status}
                    </Pill>
                  </View>
                </View>
                <Text style={styles.cardSub}>
                  {lineCount} line{lineCount === 1 ? "" : "s"} · started by{" "}
                  {s.startedBy?.username ?? "—"} · {fmtDate(s.startedAt)}
                  {s.status === "COMMITTED" && s.committedBy
                    ? ` · committed by ${s.committedBy.username}`
                    : ""}
                </Text>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: {
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    padding: 24,
  },
  filterRow: { flexGrow: 0, marginTop: 4, marginBottom: 4 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: ios.fill3,
  },
  filterChipActive: { backgroundColor: ios.brand },
  filterChipText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  filterChipTextActive: { color: "#fff" },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardSub: { fontSize: 12.5, fontFamily: "Inter_400Regular", color: ios.label2 },
  varianceText: {
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
    fontVariant: ["tabular-nums"],
  },
});
