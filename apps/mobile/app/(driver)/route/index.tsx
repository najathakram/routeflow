import React, { useState } from "react";
import { Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { format, addMinutes } from "date-fns";
import {
  useActiveRouteRun,
  useScheduledRouteRuns,
  useRouteRun,
  useUpdateRunStatus,
  useUpdateStopStatus,
  type RouteRunStop,
} from "../../../lib/api/routes";
import { useConfirmOrder } from "../../../lib/api/orders";
import { useRouteStore } from "../../../store/routeStore";
import { useMileageStore } from "../../../store/mileageStore";
import { NetworkError } from "../../../components/NetworkError";

// ─── ETA helpers ──────────────────────────────────────────────────────────────
const TRAVEL_MINS = 15;
const SERVICE_MINS = 10;
const WARN_MINS = 30; // show warning when < 30 min before window closes

function calcStopEtas(stops: RouteRunStop[], startedAt: Date = new Date()): Map<string, Date> {
  const map = new Map<string, Date>();
  let idx = 0;
  for (const stop of stops) {
    if (stop.status === "COMPLETED" || stop.status === "SKIPPED") continue;
    idx++;
    map.set(stop.id, addMinutes(startedAt, idx * (TRAVEL_MINS + SERVICE_MINS)));
  }
  return map;
}

function parseWindowTime(timeStr: string | null | undefined, baseDate: Date): Date | null {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const d = new Date(baseDate);
  d.setHours(h, m, 0, 0);
  return d;
}

type EtaStatus = "ok" | "warn" | "late" | "anytime";

function getEtaStatus(stop: RouteRunStop, eta: Date | undefined, now: Date): EtaStatus {
  const windowEnd = stop.customer?.deliveryWindowEnd;
  const windowStart = stop.customer?.deliveryWindowStart;
  if (!windowEnd && !windowStart) return "anytime";
  if (!eta) return "ok";
  const windowEndDate = parseWindowTime(windowEnd, now);
  if (!windowEndDate) return "ok";
  if (eta > windowEndDate) return "late";
  const minsUntilClose = (windowEndDate.getTime() - eta.getTime()) / 60000;
  if (minsUntilClose <= WARN_MINS) return "warn";
  return "ok";
}


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

function StopRow({ stop, runId, eta, etaStatus }: { stop: RouteRunStop; runId: string; eta?: Date; etaStatus?: EtaStatus }) {
  const icon = STATUS_ICON[stop.status] ?? STATUS_ICON.PENDING;
  const isActive = stop.status === "IN_PROGRESS";

  const businessName = stop.customer?.businessName ?? stop.customerId;
  const address = stop.customerAddress
    ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state}`
    : null;

  const windowStart = stop.customer?.deliveryWindowStart;
  const windowEnd = stop.customer?.deliveryWindowEnd;
  const hasWindow = windowStart || windowEnd;

  // Count total items across all orders at this stop
  const itemCount = (stop.orders ?? []).reduce(
    (sum, o) => sum + (o.lineItems?.length ?? 0),
    0,
  );

  const handlePress = () => {
    router.push(`/(driver)/route/stop/${stop.id}?runId=${runId}`);
  };

  const windowColor = etaStatus === "late" ? colors.danger?.DEFAULT ?? "#ef4444"
    : etaStatus === "warn" ? colors.warning.DEFAULT
    : "#94a3b8";

  return (
    <Pressable
      style={[styles.stopRow, isActive && styles.stopRowActive]}
      onPress={handlePress}
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
        {/* Delivery window line */}
        {hasWindow ? (
          <Text style={[styles.stopWindow, { color: windowColor }]}>
            {etaStatus === "late" ? "⚠ Late — " : etaStatus === "warn" ? "⚠ Tight — " : ""}
            {windowStart && windowEnd ? `${windowStart} – ${windowEnd}` : windowEnd ? `By ${windowEnd}` : `From ${windowStart}`}
          </Text>
        ) : (
          <Text style={styles.stopWindowAny}>Any time</Text>
        )}
      </View>

      {/* ETA badge for warn/late, or status icon */}
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        {etaStatus === "late" && (
          <View style={stopBadgeStyles.lateBadge}>
            <Text style={stopBadgeStyles.lateText}>Late</Text>
          </View>
        )}
        {etaStatus === "warn" && (
          <Ionicons name="warning-outline" size={16} color={colors.warning.DEFAULT} />
        )}
        <Ionicons name={icon.name as any} size={28} color={icon.color} />
      </View>
    </Pressable>
  );
}

const stopBadgeStyles = StyleSheet.create({
  lateBadge: {
    backgroundColor: "#fee2e2",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  lateText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: "#ef4444",
  },
});

export default function RouteScreen() {
  const { data, isLoading, isError, refetch } = useActiveRouteRun();
  const { data: scheduledData, refetch: refetchScheduled } = useScheduledRouteRuns();
  const setActiveRunId = useRouteStore((s) => s.setActiveRunId);
  const { logMileage, updateEnd, getEntry, getMiles } = useMileageStore();
  const { mutate: updateStopStatus } = useUpdateStopStatus();

  // Mileage modal state
  const [mileageModalVisible, setMileageModalVisible] = useState(false);
  const [mileageMode, setMileageMode] = useState<"start" | "end">("start");
  const [startOdoInput, setStartOdoInput] = useState("");
  const [endOdoInput, setEndOdoInput] = useState("");

  // Prefer in-progress run; fall back to first scheduled run
  const runRef = data?.data?.[0] ?? scheduledData?.data?.[0] ?? null;
  const activeRunId = runRef?.id ?? null;

  const { data: fullRun, isLoading: isLoadingRun, refetch: refetchFullRun } = useRouteRun(activeRunId ?? "");

  const [refreshing, setRefreshing] = React.useState(false);
  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetch(), refetchScheduled(), refetchFullRun()]);
    setRefreshing(false);
  }, [refetch, refetchScheduled, refetchFullRun]);
  const { mutate: updateStatus, isPending: isUpdating } = useUpdateRunStatus();

  // Pending confirmation from active run stops — used in the active run widget
  const { mutate: confirmOrder, isPending: isConfirming } = useConfirmOrder();

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

  // todayLabel must be computed before early returns
  const todayLabel = format(new Date(), "EEEE, MMM d");

  if (!run) {
    return (
      <>
        <Stack.Screen
          options={{
            title: "My Route",
            headerRight: () => (
              <Pressable
                onPress={() => router.push("/(driver)/route/new-run" as any)}
                style={{ padding: 4, paddingRight: 8 }}
                accessibilityLabel="Schedule a run"
              >
                <Ionicons name="add-circle-outline" size={26} color={colors.brand[500]} />
              </Pressable>
            ),
          }}
        />
        <View style={{ flex: 1, backgroundColor: colors.surface.raised, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Ionicons name="map-outline" size={56} color="#cbd5e1" />
          <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: colors.navy.DEFAULT, marginTop: 16, textAlign: "center" }}>
            No Active Route
          </Text>
          <Text style={{ fontSize: 15, fontFamily: "Inter_400Regular", color: "#64748b", marginTop: 8, textAlign: "center", lineHeight: 22 }}>
            You have no route running today. Schedule a run or manage your day from the Home tab.
          </Text>
          <Pressable
            style={{ marginTop: 24, backgroundColor: colors.brand[500], borderRadius: 12, paddingHorizontal: 28, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 8 }}
            onPress={() => router.push("/(driver)/route/new-run" as any)}
            accessibilityRole="button"
          >
            <Ionicons name="calendar-outline" size={18} color="#fff" />
            <Text style={{ fontSize: 16, fontFamily: "Inter_700Bold", color: "#fff" }}>Schedule a Run</Text>
          </Pressable>
        </View>
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

  // ETA computation (client-side)
  const now = new Date();
  const startedAt = run.startedAt ? new Date(run.startedAt) : now;
  const etaMap = hasStarted ? calcStopEtas(stops, startedAt) : new Map<string, Date>();
  const etaStatusMap = new Map<string, EtaStatus>();
  for (const stop of stops) {
    etaStatusMap.set(stop.id, getEtaStatus(stop, etaMap.get(stop.id), now));
  }
  const atRiskCount = Array.from(etaStatusMap.values()).filter(
    (s) => s === "warn" || s === "late",
  ).length;

  // Dashboard stats
  const pendingOrderCount = stops.reduce(
    (n, s) => n + (s.orders ?? []).filter((o: any) => o.status === "PENDING").length,
    0,
  );
  const totalItemCount = stops.reduce(
    (n, s) => n + (s.orders ?? []).reduce((sum: number, o: any) => sum + (o.lineItems?.length ?? 0), 0),
    0,
  );

  const primaryLabel = allDone
    ? "Route Complete"
    : !hasStarted
      ? "Start Route"
      : "Next Stop";

  // End Route Early
  const handleEndRouteEarly = () => {
    const pendingStops = stops.filter((s) => s.status === "PENDING" || s.status === "IN_PROGRESS");
    Alert.alert(
      "End Route Early?",
      `${pendingStops.length} stop${pendingStops.length !== 1 ? "s" : ""} will be marked as skipped.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End Route",
          style: "destructive",
          onPress: () => {
            // Skip all pending/in-progress stops
            for (const stop of pendingStops) {
              updateStopStatus({ runId: run.id, stopId: stop.id, status: "SKIPPED" });
            }
            // Mark run as completed
            updateStatus({ id: run.id, status: "COMPLETED" });
          },
        },
      ],
    );
  };

  // ─── Mileage logging ──────────────────────────────────────────────────────
  const mileageEntry = run ? getEntry(run.id) : null;
  const loggedMiles = run ? getMiles(run.id) : null;

  const handleLogMileage = () => {
    if (!run) return;
    const existingEntry = getEntry(run.id);
    if (existingEntry && existingEntry.endOdometer == null) {
      setMileageMode("end");
      setStartOdoInput(String(existingEntry.startOdometer));
      setEndOdoInput("");
    } else {
      setMileageMode("start");
      setStartOdoInput("");
      setEndOdoInput("");
    }
    setMileageModalVisible(true);
  };

  const handleMileageSave = () => {
    if (!run) return;
    if (mileageMode === "end") {
      const end = parseFloat(endOdoInput);
      if (isNaN(end)) {
        Alert.alert("Invalid", "Please enter a valid number for the end odometer.");
        return;
      }
      updateEnd(run.id, end);
    } else {
      const start = parseFloat(startOdoInput);
      if (isNaN(start)) {
        Alert.alert("Invalid", "Please enter a valid number for the start odometer.");
        return;
      }
      const end = endOdoInput.trim() ? parseFloat(endOdoInput) : null;
      logMileage(run.id, start, end != null && !isNaN(end) ? end : null);
    }
    setMileageModalVisible(false);
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
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 4, paddingRight: 4 }}>
              {run && (
                <>
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
                </>
              )}
              <Pressable
                onPress={() => router.push("/(driver)/route/new-run" as any)}
                style={{ padding: 4 }}
                accessibilityLabel="Schedule a run"
              >
                <Ionicons name="add-circle-outline" size={26} color={colors.brand[500]} />
              </Pressable>
            </View>
          ),
        }}
      />
      {/* ─── Mileage Modal ─────────────────────────────────────────────── */}
      <Modal
        visible={mileageModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMileageModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={mileageStyles.overlay}
        >
          <View style={mileageStyles.sheet}>
            <Text style={mileageStyles.title}>
              {mileageMode === "end" ? "Update Mileage" : "Log Mileage"}
            </Text>

            {mileageMode === "start" && (
              <View style={mileageStyles.field}>
                <Text style={mileageStyles.fieldLabel}>Start Odometer (mi)</Text>
                <TextInput
                  style={mileageStyles.input}
                  value={startOdoInput}
                  onChangeText={setStartOdoInput}
                  keyboardType="numeric"
                  placeholder="e.g. 45200"
                  placeholderTextColor="#94a3b8"
                  autoFocus
                  returnKeyType="next"
                />
              </View>
            )}

            {mileageMode === "end" && (
              <View style={mileageStyles.field}>
                <Text style={mileageStyles.fieldLabel}>Start Odometer (mi)</Text>
                <TextInput
                  style={[mileageStyles.input, mileageStyles.inputDisabled]}
                  value={startOdoInput}
                  editable={false}
                  keyboardType="numeric"
                  placeholderTextColor="#94a3b8"
                />
              </View>
            )}

            <View style={mileageStyles.field}>
              <Text style={mileageStyles.fieldLabel}>
                End Odometer (mi){mileageMode === "start" ? " — optional if still driving" : ""}
              </Text>
              <TextInput
                style={mileageStyles.input}
                value={endOdoInput}
                onChangeText={setEndOdoInput}
                keyboardType="numeric"
                placeholder="e.g. 45348"
                placeholderTextColor="#94a3b8"
                autoFocus={mileageMode === "end"}
                returnKeyType="done"
                onSubmitEditing={handleMileageSave}
              />
            </View>

            <View style={mileageStyles.actions}>
              <Pressable
                style={mileageStyles.cancelBtn}
                onPress={() => setMileageModalVisible(false)}
              >
                <Text style={mileageStyles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={mileageStyles.saveBtn} onPress={handleMileageSave}>
                <Text style={mileageStyles.saveBtnText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <View style={styles.container}>
        {/* Route header card */}
        <View style={styles.headerCard}>
          <Text style={styles.todayLabel}>{todayLabel}</Text>
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

          {/* Stats row */}
          <View style={styles.statsRow}>
            <View style={styles.statPill}>
              <Ionicons name="location-outline" size={14} color={colors.brand[500]} />
              <Text style={styles.statText}>{totalStops} stops</Text>
            </View>
            <View style={styles.statPill}>
              <Ionicons name="cube-outline" size={14} color="#64748b" />
              <Text style={styles.statText}>{totalItemCount} items</Text>
            </View>
            {pendingOrderCount > 0 && (
              <View style={[styles.statPill, styles.statPillWarning]}>
                <Ionicons name="alert-circle-outline" size={14} color={colors.warning.DEFAULT} />
                <Text style={[styles.statText, { color: colors.warning.DEFAULT }]}>
                  {pendingOrderCount} to confirm
                </Text>
              </View>
            )}
            {atRiskCount > 0 && (
              <View style={[styles.statPill, styles.statPillDanger]}>
                <Ionicons name="time-outline" size={14} color="#ef4444" />
                <Text style={[styles.statText, { color: "#ef4444" }]}>
                  {atRiskCount} at risk
                </Text>
              </View>
            )}
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {/* Before You Leave — shown for scheduled (not yet started) runs */}
          {!hasStarted && !allDone && (
            <View style={{ backgroundColor: colors.brand[50], borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.brand[100] ?? colors.brand[500] + "33", gap: 12, marginBottom: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="clipboard-outline" size={18} color={colors.brand[500]} />
                <Text style={{ fontSize: 14, fontFamily: "Inter_700Bold", color: colors.brand[500] }}>Before You Leave</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable
                  style={{ flex: 1, backgroundColor: "#fff", borderRadius: 10, padding: 14, alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.brand[100] ?? "#dbeafe" }}
                  onPress={() => router.push(`/(driver)/route/packing-list?runId=${run.id}` as any)}
                  accessibilityRole="button"
                  accessibilityLabel="View packing list"
                >
                  <Ionicons name="list-outline" size={24} color={colors.brand[500]} />
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: colors.navy.DEFAULT, textAlign: "center" }}>Packing List</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#64748b", textAlign: "center" }}>{totalItemCount} items</Text>
                </Pressable>
                <Pressable
                  style={{ flex: 1, backgroundColor: "#fff", borderRadius: 10, padding: 14, alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.brand[100] ?? "#dbeafe" }}
                  onPress={() => router.push(`/(driver)/route/map?runId=${run.id}` as any)}
                  accessibilityRole="button"
                  accessibilityLabel="View route map"
                >
                  <Ionicons name="map-outline" size={24} color={colors.brand[500]} />
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: colors.navy.DEFAULT, textAlign: "center" }}>Route Map</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#64748b", textAlign: "center" }}>{totalStops} stops</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Pending confirmation widget — derived from run stops, zero extra API calls */}
          {(() => {
            const pendingRunOrders = (run?.stops ?? [])
              .filter((s: any) => s.status !== "COMPLETED" && s.status !== "SKIPPED")
              .flatMap((s: any) =>
                (s.orders ?? [])
                  .filter((o: any) => o.status === "PENDING")
                  .map((o: any) => ({ ...o, customerName: s.customer?.businessName ?? "Customer" }))
              );
            if (pendingRunOrders.length === 0) return null;
            return (
              <View style={dashStyles.runPendingCard}>
                <View style={dashStyles.sectionLabelRow}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="alert-circle-outline" size={15} color={colors.warning.DEFAULT} />
                    <Text style={[dashStyles.runPendingTitle]}>Pending Confirmation</Text>
                  </View>
                  <View style={dashStyles.pendingBadge}>
                    <Text style={dashStyles.pendingBadgeText}>{pendingRunOrders.length}</Text>
                  </View>
                </View>
                {pendingRunOrders.map((order: any, idx: number) => (
                  <View key={order.id}>
                    {idx > 0 && <View style={dashStyles.pendingDivider} />}
                    <View style={dashStyles.pendingRow}>
                      <Pressable
                        style={{ flex: 1 }}
                        onPress={() => router.push(`/(driver)/orders/${order.id}` as any)}
                        accessibilityRole="button"
                        accessibilityLabel={`View order for ${order.customerName}`}
                      >
                        <Text style={dashStyles.pendingOrderNum}>{order.customerName}</Text>
                        <Text style={dashStyles.pendingItemCount}>
                          {order.orderNumber ?? `ORD-${order.id.slice(-5).toUpperCase()}`} · {order.lineItems?.length ?? 0} item{(order.lineItems?.length ?? 0) !== 1 ? "s" : ""}
                        </Text>
                        <Text style={dashStyles.pendingTapHint}>Tap to view →</Text>
                      </Pressable>
                      <Pressable
                        style={[dashStyles.confirmBtn, isConfirming && { opacity: 0.6 }]}
                        onPress={() => confirmOrder(order.id)}
                        disabled={isConfirming}
                        accessibilityRole="button"
                        accessibilityLabel={`Confirm order for ${order.customerName}`}
                      >
                        <Ionicons name="checkmark" size={14} color="#fff" />
                        <Text style={dashStyles.confirmBtnText}>Confirm</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            );
          })()}

          <Text style={styles.stopsLabel}>Stops</Text>
          {stops.map((stop) => (
            <StopRow
              key={stop.id}
              stop={stop}
              runId={run.id}
              eta={etaMap.get(stop.id)}
              etaStatus={etaStatusMap.get(stop.id)}
            />
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

          {/* End Route Early */}
          {hasStarted && !allDone && (
            <Pressable
              style={styles.endRouteBtn}
              onPress={handleEndRouteEarly}
              accessibilityRole="button"
              accessibilityLabel="End route early"
            >
              <Ionicons name="stop-circle-outline" size={17} color="#ef4444" />
              <Text style={styles.endRouteBtnText}>End Route Early</Text>
            </Pressable>
          )}
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
    gap: 12,
  },
  todayLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
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
  statsRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  statPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surface.raised,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  statPillWarning: {
    backgroundColor: colors.warning.bg ?? "#fef3c7",
    borderColor: colors.warning.DEFAULT + "40",
  },
  statPillDanger: {
    backgroundColor: "#fee2e2",
    borderColor: "#fca5a5",
  },
  statText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
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
  stopWindow: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  stopWindowAny: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
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
  endRouteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: "#fca5a5",
    backgroundColor: "#fee2e2",
  },
  endRouteBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#ef4444",
  },
});

// ─── Mileage modal styles ─────────────────────────────────────────────────────
const mileageStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    gap: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  field: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.lg,
    paddingHorizontal: 14,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  inputDisabled: {
    backgroundColor: "#f8fafc",
    color: "#94a3b8",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    flex: 1,
    height: 50,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
  saveBtn: {
    flex: 2,
    height: 50,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});

// ─── Active-run pending confirmation widget styles ────────────────────────────
const dashStyles = StyleSheet.create({
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pendingBadge: {
    backgroundColor: colors.warning.DEFAULT,
    borderRadius: 10,
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  pendingBadgeText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  pendingDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    marginHorizontal: 16,
  },
  pendingOrderNum: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  pendingItemCount: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
  },
  pendingTapHint: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: colors.brand[500],
    marginTop: 3,
  },
  confirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.success.DEFAULT,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  confirmBtnText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  runPendingCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.warning.DEFAULT + "40",
    marginBottom: 4,
  },
  runPendingTitle: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: colors.warning.DEFAULT,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
});
