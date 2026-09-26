import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { unitsLabel } from "@routeflow/pricing";
import type { DemandRange } from "@routeflow/types";
import { isDemandForbidden, useProductDemand } from "../lib/api/product-demand";
import { usePlanFlag } from "../lib/api/billing";
import { planFlagVisible } from "../lib/plan-flags";
import {
  chartBars,
  DEMAND_RANGE_OPTIONS,
  monthYear,
  rangeNoun,
  fmtDemandMoney,
  suggestRange,
  type DemandMetric,
} from "../lib/demand-chart-logic";
import { DemandBarChart } from "./charts/DemandBarChart";

const METRICS: readonly { value: DemandMetric; label: string; aria: string }[] = [
  { value: "units", label: "Units", aria: "Show units sold" },
  { value: "revenue", label: "Revenue", aria: "Show revenue" },
];

function Segmented<T extends string>({
  options,
  value,
  onChange,
  groupLabel,
}: {
  options: readonly { value: T; label: string; aria: string }[];
  value: T;
  onChange: (v: T) => void;
  groupLabel: string;
}) {
  return (
    <View style={styles.seg} accessibilityRole="radiogroup" accessibilityLabel={groupLabel}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            style={[styles.segBtn, on && styles.segBtnOn]}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityLabel={o.aria}
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.segText, on && styles.segTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Sales-demand chart for the product detail screen (mirrors web's DemandCard).
 * Hidden for a tenant whose plan lacks `flag.analytics` (and on a 403) — never flashes
 * a loading state for a locked tenant.
 */
export function ProductDemandCard({
  productId,
  unitsPerBox,
}: {
  productId: string;
  unitsPerBox?: number | null;
}) {
  const flag = usePlanFlag("flag.analytics");
  if (!planFlagVisible(flag)) return null;
  return <DemandCardBody productId={productId} unitsPerBox={unitsPerBox} />;
}

function DemandCardBody({
  productId,
  unitsPerBox,
}: {
  productId: string;
  unitsPerBox?: number | null;
}) {
  // Default 6M: most products have no sales in any given 30-day window.
  const [range, setRange] = useState<DemandRange>("6m");
  const [metric, setMetric] = useState<DemandMetric>("units");
  const { data, isLoading, isError, error, isFetching, refetch } = useProductDemand(
    productId,
    range,
  );

  const shownRange = data?.range ?? range;
  const series = useMemo(
    () => (data ? chartBars(data.buckets, metric, data.granularity) : null),
    [data, metric],
  );

  if (isError && isDemandForbidden(error)) return null;

  const neverSold = !!data && !data.hasAnySales;
  const emptyWindow = !!data && data.hasAnySales && data.totals.units === 0;
  const suggested = data ? suggestRange(data.lastSaleAt, shownRange, Date.now()) : null;
  const noun = rangeNoun(shownRange);
  const headline = data
    ? `${
        metric === "revenue"
          ? `${fmtDemandMoney(data.totals.revenue)} invoiced`
          : unitsLabel(data.totals.units, unitsPerBox)
      } over the last ${noun}`
    : "";

  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        Sales demand
      </Text>

      {isLoading ? (
        <View style={styles.state}>
          <ActivityIndicator color={ios.brand} accessibilityLabel="Loading demand" />
        </View>
      ) : isError ? (
        <View style={styles.state}>
          <Text style={styles.muted}>Couldn't load demand.</Text>
          <Pressable
            style={styles.linkBtn}
            onPress={() => refetch()}
            accessibilityRole="button"
            accessibilityLabel="Try loading demand again"
          >
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      ) : neverSold ? (
        <View style={styles.state}>
          <Text style={styles.strong}>Never sold</Text>
          <Text style={styles.muted}>This product has not appeared on an invoice yet.</Text>
        </View>
      ) : (
        data &&
        series && (
          <>
            <View style={styles.controls}>
              <Segmented
                options={DEMAND_RANGE_OPTIONS}
                value={range}
                onChange={setRange}
                groupLabel="Demand range"
              />
              {!emptyWindow ? (
                <Segmented
                  options={METRICS}
                  value={metric}
                  onChange={setMetric}
                  groupLabel="Demand metric"
                />
              ) : null}
            </View>
            {emptyWindow ? (
              <View style={styles.state}>
                <Text style={styles.muted}>No sales in the last {noun}.</Text>
                {data.lastSaleAt ? (
                  <>
                    <Text style={styles.muted}>Last sold {monthYear(data.lastSaleAt)}.</Text>
                    {suggested ? (
                      <Pressable
                        style={styles.linkBtn}
                        onPress={() => setRange(suggested)}
                        accessibilityRole="button"
                      >
                        <Text style={styles.link}>
                          View{" "}
                          {DEMAND_RANGE_OPTIONS.find(
                            (o) => o.value === suggested,
                          )!.aria.toLowerCase()}
                        </Text>
                      </Pressable>
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : (
              <View style={isFetching ? styles.stale : undefined}>
                <Text style={styles.summary}>
                  {headline} · by {data.granularity}.
                </Text>
                <DemandBarChart
                  bars={series.bars}
                  color={metric === "revenue" ? ios.system.green : ios.brand}
                  summary={`${headline}, ${series.bars.length} ${data.granularity} bars.`}
                />
                {data.firstSaleAt &&
                data.buckets.length > 1 &&
                data.firstSaleAt >= data.buckets[1].date ? (
                  <Text style={styles.note}>
                    Sales history starts {monthYear(data.firstSaleAt)}; earlier bars are empty.
                  </Text>
                ) : null}
              </View>
            )}
          </>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 10 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  seg: { flexDirection: "row", backgroundColor: ios.fill3, borderRadius: 9, padding: 2 },
  segBtn: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  segBtnOn: { backgroundColor: ios.bgElev },
  segText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  segTextOn: { color: ios.brand, fontFamily: "Inter_600SemiBold" },
  state: { alignItems: "center", justifyContent: "center", gap: 6, minHeight: 100 },
  strong: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  muted: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  linkBtn: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
  link: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  summary: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2, marginBottom: 8 },
  note: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 6 },
  stale: { opacity: 0.6 },
});
