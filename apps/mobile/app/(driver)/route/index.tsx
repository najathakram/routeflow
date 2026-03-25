import { Alert, Pressable, ScrollView, StyleSheet, Text, View, ActivityIndicator } from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { EmptyState, StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useActiveRouteRun,
  useScheduledRouteRuns,
  useRouteRun,
  useUpdateRunStatus,
  type RouteRunStop,
} from "../../../lib/api/routes";
import { useRouteStore } from "../../../store/routeStore";
import { useMileageStore } from "../../../store/mileageStore";
import { NetworkError } from "../../../components/NetworkError";

const STATUS_ICON: Record<string, { name: string; color: string }> = {
  COMPLETED: { name: "checkmark-circle", color: colors.success.DEFAULT },
  IN_PROGRESS: { name: "arrow-forward-circle", color: colors.brand[500] },
  PENDING: { name: "ellipse-outline", color: "#94a3b8" },
  SKIPPED: { name: "close-circle-outline", color: "#94a3b8" },
};

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total === 0 ? 0 : (completed / total) * 100;
  return (
    <View style={progressStyles.track}>
      <View style={[progressStyles.fill, { width: `${pct}%` as any }]} />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface.border,
    overflow: "hidden",
  },
  fill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success.DEFAULT,
  },
});

function StopRow({ stop, runId }: { stop: RouteRunStop; runId: string }) {
  const icon = STATUS_ICON[stop.status] ?? STATUS_ICON.PENDING;
  const isActive = stop.status === "IN_PROGRESS";

  const businessName = stop.customer?.businessName ?? stop.customerId;
  const address = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state}`
    : null;

  // Count total items across all orders at this stop
  const itemCount = (stop.orders ?? []).reduce(
    (sum, o) => sum + (o.lineItems?.length ?? 0),
    0,
  );

  return (
    <Pressable
      style={[styles.stopRow, isActive && styles.stopRowActive]}
      onPress={() => router.push(`/(driver)/route/stop/${stop.id}?runId=${runId}`)}
      accessibilityRole="button"
      accessibilityLabel={`Stop ${stop.stopNumber}: ${businessName}`}
    >
      {/* Stop number bubble */}
      <View style={[styles.stopNumBubble, isActive && styles.stopNumBubbleActive]}>
        <Text style={[styles.stopNum, isActive && styles.stopNumActive]}>
          {stop.stopNumber}
        </Text>
      </View>

      {/* Details */}
      <View style={styles.stopDetails}>
        <Text style={styles.stopBusiness}>{businessName}</Text>
        {address ? (
          <Text style={styles.stopAddress} numberOfLines={1}>
            {address}
          </Text>
        ) : null}
        {itemCount > 0 && (
          <Text style={styles.stopItemCount}>
            {itemCount} item{itemCount !== 1 ? "s" : ""}
          </Text>
        )}
      </View>

      {/* Status icon */}
      <Ionicons name={icon.name as any} size={28} color={icon.color} />
    </Pressable>
  );
}

export default function RouteScreen() {
  const { data, isLoading, isError, refetch } = useActiveRouteRun();
  const { data: scheduledData } = useScheduledRouteRuns();
  const setActiveRunId = useRouteStore((s) => s.setActiveRunId);
  const { logMileage, updateEnd, getEntry, getMiles } = useMileageStore();

  // Prefer in-progress run; fall back to first scheduled run
  const runRef = data?.data?.[0] ?? scheduledData?.data?.[0] ?? null;
  const activeRunId = runRef?.id ?? null;

  const { data: fullRun, isLoading: isLoadingRun } = useRouteRun(activeRunId ?? "");
  const { mutate: updateStatus, isPending: isUpdating } = useUpdateRunStatus();

  if (isLoading || (activeRunId && isLoadingRun)) {
    return (
      <>
        <Stack.Screen options={{ title: "My Route" }} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "My Route" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const run = fullRun ?? runRef;

  if (!run) {
    return (
      <>
        <Stack.Screen options={{ title: "My Route" }} />
        <EmptyState
          icon={<Ionicons name="map-outline" size={56} color="#cbd5e1" />}
          title="No route assigned today."
          subtitle="Check back later or contact your dispatcher."
        />
      </>
    );
  }

  // Store active runId for stop screens
  if (activeRunId) setActiveRunId(activeRunId);

  const stops = run.stops ?? [];
  const totalStops = stops.length;
  const completedCount = stops.filter(
    (s) => s.status === "COMPLETED" || s.status === "SKIPPED",
  ).length;
  const currentStop = stops.find((s) => s.status === "IN_PROGRESS") ?? null;
  const allDone = run.status === "COMPLETED";
  const hasStarted = run.status === "IN_PROGRESS" || completedCount > 0 || currentStop !== null;

  const primaryLabel = allDone
    ? "Route Complete"
    : !hasStarted
      ? "Start Route"
      : "Next Stop";

  // ─── Mileage logging ──────────────────────────────────────────────────────
  const mileageEntry = run ? getEntry(run.id) : null;
  const loggedMiles = run ? getMiles(run.id) : null;

  const handleLogMileage = () => {
    if (!run) return;
    const existingEntry = getEntry(run.id);

    if (existingEntry && existingEntry.endOdometer == null) {
      // End odometer not yet set — prompt for it
      Alert.prompt(
        "End Odometer",
        "Enter your current odometer reading (end of route):",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Save",
            onPress: (value) => {
              const end = parseFloat(value ?? "");
              if (isNaN(end)) {
                Alert.alert("Invalid", "Please enter a valid number.");
                return;
              }
              updateEnd(run.id, end);
            },
          },
        ],
        "plain-text",
        String(existingEntry.startOdometer),
        "numeric",
      );
      return;
    }

    // Start odometer prompt
    Alert.prompt(
      "Log Mileage",
      "Enter your starting odometer reading:",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Next",
          onPress: (startValue) => {
            const start = parseFloat(startValue ?? "");
            if (isNaN(start)) {
              Alert.alert("Invalid", "Please enter a valid number.");
              return;
            }
            // Immediately ask for end odometer too
            Alert.prompt(
              "Log Mileage",
              "Enter your ending odometer reading (leave blank if still driving):",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Save",
                  onPress: (endValue) => {
                    const end = endValue ? parseFloat(endValue) : null;
                    logMileage(run.id, start, isNaN(end as number) ? null : end);
                  },
                },
              ],
              "plain-text",
              "",
              "numeric",
            );
          },
        },
      ],
      "plain-text",
      "",
      "numeric",
    );
  };

  const handlePrimaryAction = () => {
    if (allDone) return;
    if (!hasStarted) {
      updateStatus({ id: run.id, status: "IN_PROGRESS" });
    }
    const target = currentStop ?? stops.find((s) => s.status === "PENDING");
    if (target) {
      router.push(`/(driver)/route/stop/${target.id}?runId=${run.id}`);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "My Route",
          headerRight: () =>
            run && (
              <View style={{ flexDirection: "row", gap: 4, paddingRight: 4 }}>
                <Pressable
                  onPress={() => router.push(`/(driver)/route/map?runId=${run.id}` as any)}
                  style={{ padding: 4 }}
                  accessibilityLabel="Map view"
                >
                  <Ionicons name="map-outline" size={22} color={colors.brand[500]} />
                </Pressable>
                <Pressable
                  onPress={() => router.push(`/(driver)/route/messages?runId=${run.id}` as any)}
                  style={{ padding: 4 }}
                  accessibilityLabel="Messages"
                >
                  <Ionicons name="chatbubble-outline" size={22} color={colors.brand[500]} />
                </Pressable>
                <Pressable
                  onPress={() => router.push(`/(driver)/route/packing-list?runId=${run.id}`)}
                  style={{ padding: 4 }}
                  accessibilityLabel="Packing list"
                >
                  <Ionicons name="list-outline" size={24} color={colors.brand[500]} />
                </Pressable>
              </View>
            ),
        }}
      />
      <View style={styles.container}>
        {/* Route header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerTop}>
            <Text style={styles.routeName}>{run.route?.name ?? "My Route"}</Text>
            <StatusBadge
              status={
                run.status === "IN_PROGRESS"
                  ? "IN_PROGRESS"
                  : run.status === "COMPLETED"
                    ? "COMPLETED"
                    : "PENDING"
              }
            />
          </View>

          <View style={styles.progressSection}>
            <View style={styles.progressLabelRow}>
              <Text style={styles.progressLabel}>Progress</Text>
              <Text style={styles.progressValue}>
                {completedCount} of {totalStops} stops
              </Text>
            </View>
            <ProgressBar completed={completedCount} total={totalStops} />
          </View>
        </View>

        {/* Stop list */}
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.stopsLabel}>Stops</Text>
          {stops.map((stop) => (
            <StopRow key={stop.id} stop={stop} runId={run.id} />
          ))}
        </ScrollView>

        {/* Primary action */}
        <View style={styles.footer}>
          {/* Mileage row — shown when route is in progress or completed */}
          {(run.status === "IN_PROGRESS" || allDone) && (
            <View style={styles.mileageRow}>
              <Pressable
                style={styles.mileageBtn}
                onPress={handleLogMileage}
                accessibilityRole="button"
                accessibilityLabel="Log mileage"
              >
                <Ionicons name="speedometer-outline" size={18} color={colors.brand[500]} />
                <Text style={styles.mileageBtnText}>
                  {mileageEntry ? "Update Mileage" : "Log Mileage"}
                </Text>
              </Pressable>
              {loggedMiles != null && (
                <View style={styles.mileageSummary}>
                  <Ionicons name="car-outline" size={16} color="#64748b" />
                  <Text style={styles.mileageSummaryText}>
                    {loggedMiles.toFixed(1)} mi logged
                  </Text>
                </View>
              )}
              {mileageEntry && mileageEntry.endOdometer == null && (
                <Text style={styles.mileagePending}>Start: {mileageEntry.startOdometer}</Text>
              )}
            </View>
          )}

          <Pressable
            style={[styles.primaryBtn, allDone && styles.primaryBtnDone]}
            onPress={handlePrimaryAction}
            disabled={allDone || isUpdating}
            accessibilityRole="button"
            accessibilityLabel={primaryLabel}
          >
            {!allDone && (
              <Ionicons
                name={hasStarted ? "navigate" : "play"}
                size={22}
                color="#fff"
                style={{ marginRight: 10 }}
              />
            )}
            {allDone && (
              <Ionicons
                name="checkmark-done-circle"
                size={22}
                color={colors.success.DEFAULT}
                style={{ marginRight: 10 }}
              />
            )}
            <Text
              style={[
                styles.primaryBtnText,
                allDone && { color: colors.success.DEFAULT },
              ]}
            >
              {primaryLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  headerCard: {
    backgroundColor: "#fff",
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
    gap: 16,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  routeName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  progressSection: {
    gap: 8,
  },
  progressLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  progressLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  progressValue: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 8,
  },
  stopsLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 14,
    minHeight: 56,
    ...shadows.card,
  },
  stopRowActive: {
    borderWidth: 1.5,
    borderColor: colors.brand[500],
  },
  stopNumBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface.raised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  stopNumBubbleActive: {
    backgroundColor: colors.brand[500],
    borderColor: colors.brand[500],
  },
  stopNum: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopNumActive: {
    color: "#fff",
  },
  stopDetails: {
    flex: 1,
    gap: 2,
  },
  stopBusiness: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopAddress: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  stopItemCount: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  primaryBtn: {
    height: 56,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnDone: {
    backgroundColor: colors.success.bg,
  },
  primaryBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  // 3-N: mileage tracking
  mileageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
    flexWrap: "wrap",
  },
  mileageBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.brand[100],
    backgroundColor: colors.brand[50],
  },
  mileageBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  mileageSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  mileageSummaryText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  mileagePending: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
