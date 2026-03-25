import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useDriverHistory, useDriverStats, type RouteRun } from "../../../lib/api/routes";
import { NetworkError } from "../../../components/NetworkError";

// ─── Compute stats locally from history when the API endpoint is absent ───────

function computeLocalStats(runs: RouteRun[]) {
  const completedRuns = runs.filter((r) => r.status === "COMPLETED");

  let totalStops = 0;
  let onTimeStops = 0;
  let totalReturns = 0;
  let stopsPerRunSum = 0;

  for (const run of completedRuns) {
    const stops = run.stops ?? [];
    const completed = stops.filter((s) => s.status === "COMPLETED");
    totalStops += completed.length;
    stopsPerRunSum += completed.length;

    for (const stop of completed) {
      const windowEnd = stop.customer?.deliveryWindowEnd;
      if (windowEnd && stop.completedAt) {
        // deliveryWindowEnd is a time string like "14:00"; completedAt is ISO
        const completedDate = new Date(stop.completedAt);
        const scheduledDate = run.scheduledDate
          ? new Date(run.scheduledDate)
          : new Date(stop.completedAt);
        const [wHour, wMin] = windowEnd.split(":").map(Number);
        const windowEndDate = new Date(
          scheduledDate.getFullYear(),
          scheduledDate.getMonth(),
          scheduledDate.getDate(),
          wHour,
          wMin,
        );
        if (completedDate <= windowEndDate) onTimeStops += 1;
      } else {
        // No window defined — count as on-time
        onTimeStops += 1;
      }
    }
  }

  const onTimeDeliveryPct =
    totalStops === 0 ? 100 : Math.round((onTimeStops / totalStops) * 100);
  const avgStopsPerRoute =
    completedRuns.length === 0 ? 0 : Math.round(stopsPerRunSum / completedRuns.length);

  return {
    totalStopsCompleted: totalStops,
    onTimeDeliveryPct,
    avgStopsPerRoute,
    returnsRate: totalStops === 0 ? 0 : Math.round((totalReturns / totalStops) * 100),
  };
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  iconColor: string;
  label: string;
  value: string;
  sub?: string;
}

function KpiCard({ icon, iconColor, label, value, sub }: KpiCardProps) {
  return (
    <View style={styles.kpiCard}>
      <View style={[styles.kpiIcon, { backgroundColor: iconColor + "18" }]}>
        <Ionicons name={icon} size={24} color={iconColor} />
      </View>
      <View style={styles.kpiBody}>
        <Text style={styles.kpiLabel}>{label}</Text>
        <Text style={styles.kpiValue}>{value}</Text>
        {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function PerformanceScreen() {
  const { data: historyData, isLoading: histLoading, isError, refetch } = useDriverHistory();
  const { data: statsData, isLoading: statsLoading } = useDriverStats();

  const isLoading = histLoading || statsLoading;

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "My Performance", headerBackTitle: "History" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "My Performance", headerBackTitle: "History" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const runs = historyData?.data ?? [];

  // Use API stats if available; fall back to local computation
  const stats = statsData ?? computeLocalStats(runs);

  const completedRuns = runs.filter((r) => r.status === "COMPLETED").length;
  const totalRuns = runs.length;

  return (
    <>
      <Stack.Screen options={{ title: "My Performance", headerBackTitle: "History" }} />
      <ScrollView
        style={styles.bg}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Summary banner */}
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>Performance Summary</Text>
          <Text style={styles.bannerSub}>
            Based on {totalRuns} route{totalRuns !== 1 ? "s" : ""} ({completedRuns} completed)
          </Text>
        </View>

        {/* KPI grid */}
        <View style={styles.grid}>
          <KpiCard
            icon="flag-outline"
            iconColor={colors.brand[500]}
            label="Stops Completed"
            value={String(stats.totalStopsCompleted)}
            sub="total deliveries"
          />
          <KpiCard
            icon="time-outline"
            iconColor={colors.success.DEFAULT}
            label="On-Time Delivery"
            value={`${stats.onTimeDeliveryPct}%`}
            sub="within window"
          />
          <KpiCard
            icon="analytics-outline"
            iconColor="#8b5cf6"
            label="Avg Stops / Route"
            value={String(stats.avgStopsPerRoute)}
            sub="per completed run"
          />
          <KpiCard
            icon="return-down-back-outline"
            iconColor={colors.danger.DEFAULT}
            label="Returns Rate"
            value={`${stats.returnsRate}%`}
            sub="of deliveries"
          />
        </View>

        {/* Recent runs breakdown */}
        {runs.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Recent Routes</Text>
            {runs.slice(0, 10).map((run) => {
              const stops = run.stops ?? [];
              const done = stops.filter(
                (s) => s.status === "COMPLETED" || s.status === "SKIPPED",
              ).length;
              return (
                <View key={run.id} style={styles.runRow}>
                  <View style={styles.runInfo}>
                    <Text style={styles.runName}>{run.route?.name ?? "Route"}</Text>
                    <Text style={styles.runDate}>
                      {run.scheduledDate
                        ? new Date(run.scheduledDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                    </Text>
                  </View>
                  <View style={styles.runStats}>
                    <Text style={styles.runStops}>
                      {done}/{stops.length} stops
                    </Text>
                    <View
                      style={[
                        styles.runBadge,
                        run.status === "COMPLETED" && styles.runBadgeComplete,
                        run.status === "IN_PROGRESS" && styles.runBadgeActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.runBadgeText,
                          run.status === "COMPLETED" && styles.runBadgeTextComplete,
                          run.status === "IN_PROGRESS" && styles.runBadgeTextActive,
                        ]}
                      >
                        {run.status === "COMPLETED"
                          ? "Done"
                          : run.status === "IN_PROGRESS"
                            ? "Active"
                            : run.status === "CANCELLED"
                              ? "Cancelled"
                              : "Scheduled"}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  bg: { backgroundColor: colors.surface.raised },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 40,
    gap: 16,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  banner: {
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.lg,
    padding: 20,
    gap: 4,
  },
  bannerTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  bannerSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.8)",
  },
  grid: {
    gap: 10,
  },
  kpiCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    ...shadows.card,
  },
  kpiIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  kpiBody: { flex: 1 },
  kpiLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
    marginBottom: 2,
  },
  kpiValue: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  kpiSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: 2,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  runRow: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    ...shadows.card,
  },
  runInfo: { gap: 2 },
  runName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  runDate: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  runStats: {
    alignItems: "flex-end",
    gap: 4,
  },
  runStops: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  runBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
    backgroundColor: "#f1f5f9",
  },
  runBadgeComplete: { backgroundColor: colors.success.bg },
  runBadgeActive: { backgroundColor: colors.brand[50] },
  runBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
  runBadgeTextComplete: { color: colors.success.DEFAULT },
  runBadgeTextActive: { color: colors.brand[500] },
});
