import React from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { format, parseISO, isToday, isTomorrow } from "date-fns";
import {
  useActiveRouteRun,
  useScheduledRouteRuns,
  useRouteRun,
  useUpdateRunStatus,
  useDriverStats,
  type RouteRun,
} from "../../lib/api/routes";
import { useMyOrders, useConfirmOrder } from "../../lib/api/orders";
import * as Haptics from "expo-haptics";
import { useAuthStore } from "../../lib/auth-store";
import { showToast } from "../../lib/toast";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const COL3 = (SCREEN_WIDTH - 48) / 3;

const TILES: Array<{
  id: string;
  label: string;
  icon: string;
  bg: string;
  color: string;
  path?: string;
  runRequired?: boolean;
}> = [
  { id: "order",    label: "New Order",     icon: "add-circle-outline",      bg: "#f0fdf4", color: "#16a34a", path: "/(driver)/orders/new" },
  { id: "customers",label: "Customers",     icon: "people-outline",          bg: "#fef3c7", color: "#d97706", path: "/(driver)/customers" },
  { id: "stock",    label: "Stock Check",   icon: "cube-outline",            bg: "#f1f5f9", color: "#475569", path: "/(driver)/inventory" },
  { id: "schedule", label: "Schedule Run",  icon: "calendar-outline",        bg: "#eff6ff", color: "#2563eb", path: "/(driver)/route/new-run" },
  { id: "history",  label: "History",       icon: "time-outline",            bg: "#f8fafc", color: "#64748b", path: "/(driver)/history" },
  { id: "perf",     label: "Performance",   icon: "stats-chart-outline",     bg: "#fdf4ff", color: "#9333ea", path: "/(driver)/history/performance" },
  { id: "adjust",   label: "Adjust Stock",  icon: "swap-horizontal-outline", bg: "#fff7ed", color: "#ea580c", path: "/(driver)/inventory/adjust" },
  { id: "purchase", label: "Purchase Req.", icon: "cart-outline",            bg: "#f0fdf4", color: "#15803d", path: "/(driver)/inventory/purchase" },
  { id: "packing",  label: "Packing List",  icon: "list-outline",            bg: "#ecfdf5", color: "#059669", runRequired: true },
  { id: "map",      label: "Route Map",     icon: "map-outline",             bg: "#eff6ff", color: "#0284c7", runRequired: true },
  { id: "messages", label: "Messages",      icon: "chatbubble-outline",      bg: "#f0f9ff", color: "#0891b2", runRequired: true },
  { id: "mileage",  label: "Log Mileage",   icon: "speedometer-outline",     bg: "#fafafa", color: "#64748b", runRequired: true },
];

// ─── Run date label helper ────────────────────────────────────────────────────

function runDateLabel(dateStr: string): string {
  try {
    const d = parseISO(dateStr);
    if (isToday(d)) return "Today";
    if (isTomorrow(d)) return "Tomorrow";
    return format(d, "EEE, MMM d");
  } catch {
    return dateStr;
  }
}

// ─── Multi-run card ───────────────────────────────────────────────────────────

function RunCard({ run }: { run: RouteRun }) {
  const { mutate: updateStatus, isPending } = useUpdateRunStatus();
  const { data: fullRun } = useRouteRun(run.id);
  const r = fullRun ?? run;

  const stops = r.stops ?? [];
  const totalStops = stops.length;
  const completedCount = stops.filter(
    (s) => s.status === "COMPLETED" || s.status === "SKIPPED",
  ).length;
  const isActive = r.status === "IN_PROGRESS";
  const dateLabel = runDateLabel(r.scheduledDate);
  const isTodayRun = (() => {
    try { return isToday(parseISO(r.scheduledDate)); }
    catch { return false; }
  })();

  const handleStart = () => {
    updateStatus({ id: r.id, status: "IN_PROGRESS" }, {
      onError: (err: any) =>
        Alert.alert("Error", err?.response?.data?.message ?? "Could not start run."),
    });
  };

  const handleStop = () => {
    Alert.alert(
      "Complete Route?",
      "Mark this route as completed?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Complete",
          onPress: () =>
            updateStatus({ id: r.id, status: "COMPLETED" }, {
              onError: (err: any) =>
                Alert.alert("Error", err?.response?.data?.message ?? "Could not complete run."),
            }),
        },
      ],
    );
  };

  const handleCancel = () => {
    Alert.alert(
      "Cancel Run?",
      "This will cancel the scheduled run. This cannot be undone.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Cancel Run",
          style: "destructive",
          onPress: () =>
            updateStatus({ id: r.id, status: "CANCELLED" }, {
              onError: (err: any) =>
                Alert.alert("Error", err?.response?.data?.message ?? "Could not cancel run."),
            }),
        },
      ],
    );
  };

  return (
    <View style={ds.runCard}>
      {/* Header */}
      <Pressable
        style={ds.runCardHeader}
        onPress={() => router.push("/(driver)/route" as any)}
        accessibilityRole="button"
        accessibilityLabel={`View ${r.route?.name ?? "route"}`}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={ds.runCardName}>{r.route?.name ?? "Route"}</Text>
          <View style={ds.runCardMeta}>
            <View
              style={[
                ds.runStatusPill,
                isActive ? ds.runStatusActive : ds.runStatusScheduled,
              ]}
            >
              <Text
                style={[
                  ds.runStatusText,
                  { color: isActive ? colors.brand[500] : "#64748b" },
                ]}
              >
                {isActive ? "IN PROGRESS" : "SCHEDULED"}
              </Text>
            </View>
            <Text style={ds.runMetaText}>
              {dateLabel} · {totalStops} stop{totalStops !== 1 ? "s" : ""}
            </Text>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#cbd5e1" />
      </Pressable>

      {/* Progress bar — in-progress only */}
      {isActive && totalStops > 0 && (
        <View style={ds.runProgress}>
          <View style={ds.runProgressTrack}>
            <View
              style={[
                ds.runProgressFill,
                { width: `${(completedCount / totalStops) * 100}%` as any },
              ]}
            />
          </View>
          <Text style={ds.runProgressText}>
            {completedCount}/{totalStops} stops done
          </Text>
        </View>
      )}

      {/* Action buttons */}
      <View style={ds.runActions}>
        {isActive ? (
          <>
            <Pressable
              style={[ds.runBtn, ds.runBtnPrimary]}
              onPress={() => {
                const next =
                  stops.find((s) => s.status === "IN_PROGRESS") ??
                  stops.find((s) => s.status === "PENDING");
                if (next) router.push(`/(driver)/route/stop/${next.id}?runId=${r.id}` as any);
                else router.push("/(driver)/route" as any);
              }}
            >
              <Ionicons name="navigate" size={14} color="#fff" />
              <Text style={ds.runBtnPrimaryText}>Next Stop</Text>
            </Pressable>
            <Pressable
              style={[ds.runBtn, ds.runBtnSecondary]}
              onPress={handleStop}
              disabled={isPending}
            >
              <Ionicons name="checkmark-done" size={14} color={colors.success.DEFAULT} />
              <Text style={ds.runBtnSecondaryText}>Complete</Text>
            </Pressable>
          </>
        ) : isTodayRun ? (
          <>
            <Pressable
              style={[ds.runBtn, ds.runBtnStart]}
              onPress={handleStart}
              disabled={isPending}
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="play" size={14} color="#fff" />
              )}
              <Text style={ds.runBtnPrimaryText}>Start Route</Text>
            </Pressable>
            <Pressable
              style={[ds.runBtn, ds.runBtnEdit]}
              onPress={() => router.push(`/(driver)/history/${r.id}` as any)}
            >
              <Ionicons name="pencil-outline" size={14} color={colors.brand[500]} />
              <Text style={ds.runBtnEditText}>Edit</Text>
            </Pressable>
            <Pressable
              style={[ds.runBtn, ds.runBtnCancel]}
              onPress={handleCancel}
              disabled={isPending}
            >
              <Ionicons name="close" size={14} color="#dc2626" />
              <Text style={ds.runBtnCancelText}>Cancel</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              style={[ds.runBtn, ds.runBtnStart]}
              onPress={handleStart}
              disabled={isPending}
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="play" size={14} color="#fff" />
              )}
              <Text style={ds.runBtnPrimaryText}>Start Route</Text>
            </Pressable>
            <Pressable
              style={[ds.runBtn, ds.runBtnEdit]}
              onPress={() => router.push(`/(driver)/history/${r.id}` as any)}
            >
              <Ionicons name="pencil-outline" size={14} color={colors.brand[500]} />
              <Text style={ds.runBtnEditText}>Reschedule</Text>
            </Pressable>
            <Pressable
              style={[ds.runBtn, ds.runBtnCancel]}
              onPress={handleCancel}
              disabled={isPending}
            >
              <Ionicons name="close" size={14} color="#dc2626" />
              <Text style={ds.runBtnCancelText}>Cancel</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const { data: activeData, refetch: refetchActive } = useActiveRouteRun();
  const { data: scheduledData, refetch: refetchScheduled } = useScheduledRouteRuns();
  const user = useAuthStore((s) => s.user);

  const activeRuns: RouteRun[] = activeData?.data ?? [];
  const scheduledRuns: RouteRun[] = scheduledData?.data ?? [];

  // Primary run for resolving tile paths (first active, or first scheduled)
  const primaryRun = activeRuns[0] ?? scheduledRuns[0] ?? null;

  const { data: pendingOrdersData, refetch: refetchPending } = useMyOrders({ status: "PENDING", limit: 5 });
  const pendingOrders = pendingOrdersData?.data ?? [];
  const { mutate: confirmOrder, isPending: isConfirming } = useConfirmOrder();
  const { data: stats, refetch: refetchStats } = useDriverStats();
  const { data: recentData, refetch: refetchRecent } = useMyOrders({ status: "DELIVERED", limit: 3 });
  const recentOrders = recentData?.data ?? [];

  const [refreshing, setRefreshing] = React.useState(false);
  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchActive(), refetchScheduled(), refetchPending(), refetchStats(), refetchRecent()]);
    setRefreshing(false);
  }, [refetchActive, refetchScheduled, refetchPending, refetchStats, refetchRecent]);

  const username = user?.username ?? "Driver";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const todayLabel = format(new Date(), "EEEE, MMMM d");

  const initials =
    username
      .split(/[\s_]/)
      .slice(0, 2)
      .map((w: string) => (w[0] ? w[0].toUpperCase() : ""))
      .join("") || (username[0] ? username[0].toUpperCase() : "D");

  const resolveRunTilePath = (id: string): string => {
    if (!primaryRun) return "";
    if (id === "packing") return `/(driver)/route/packing-list?runId=${primaryRun.id}`;
    if (id === "map") return `/(driver)/route/map?runId=${primaryRun.id}`;
    if (id === "messages") return `/(driver)/route/messages?runId=${primaryRun.id}`;
    return "/(driver)/route";
  };

  const allRuns = [
    ...activeRuns,
    ...scheduledRuns.filter((r) => !activeRuns.find((a) => a.id === r.id)),
  ];

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={ds.screen}
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* ── Hero header ───────────────────────────────────────────── */}
        <View style={ds.hero}>
          <View style={ds.heroRow}>
            <View style={{ flex: 1 }}>
              <Text style={ds.heroDate}>{todayLabel}</Text>
              <Text style={ds.heroGreeting}>{greeting}, {username}</Text>
            </View>
            <View style={ds.avatar}>
              <Text style={ds.avatarText}>{initials}</Text>
            </View>
          </View>
        </View>

        <View style={ds.body}>
          {/* ── ALL RUNS ──────────────────────────────────────────────── */}
          <View style={ds.section}>
            <View style={ds.labelRow}>
              <Text style={ds.label}>
                {activeRuns.length > 0 ? "Running Routes" : "Upcoming Routes"}
              </Text>
              <Pressable
                onPress={() => router.push("/(driver)/route/new-run" as any)}
                style={ds.scheduleCta}
              >
                <Ionicons name="add" size={14} color={colors.brand[500]} />
                <Text style={ds.scheduleCtaText}>Schedule</Text>
              </Pressable>
            </View>

            {allRuns.length === 0 ? (
              <Pressable
                style={[ds.card, ds.routeEmpty]}
                onPress={() => router.push("/(driver)/route/new-run" as any)}
                accessibilityRole="button"
              >
                <Ionicons name="calendar-outline" size={32} color="#94a3b8" />
                <View style={{ flex: 1 }}>
                  <Text style={ds.routeEmptyTitle}>No routes scheduled</Text>
                  <Text style={ds.routeEmptyMeta}>Tap to schedule a run</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
              </Pressable>
            ) : (
              allRuns.map((run) => <RunCard key={run.id} run={run} />)
            )}
          </View>

          {/* ── PENDING CONFIRMATION (from pending orders) ─────────────── */}
          {pendingOrders.length > 0 && (
            <View style={ds.section}>
              <View style={ds.labelRow}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ionicons name="time-outline" size={14} color="#d97706" />
                  <Text style={[ds.label, { color: "#d97706" }]}>Unconfirmed Orders</Text>
                </View>
                <View style={ds.badge}><Text style={ds.badgeText}>{pendingOrders.length}</Text></View>
              </View>
              <View style={ds.card}>
                {pendingOrders.slice(0, 3).map((order: any, idx: number) => (
                  <View key={order.id}>
                    {idx > 0 && <View style={ds.divider} />}
                    <View style={ds.pendingRow}>
                      <Pressable
                        style={{ flex: 1 }}
                        onPress={() => router.push(`/(driver)/orders/${order.id}` as any)}
                        accessibilityRole="button"
                        accessibilityLabel={`View order ${order.orderNumber}`}
                      >
                        <Text style={ds.pendingPrimary}>
                          {order.orderNumber ?? `ORD-${order.id.slice(-5).toUpperCase()}`}
                        </Text>
                        <Text style={ds.pendingSecondary}>
                          {order.lineItems?.length ?? 0} item{(order.lineItems?.length ?? 0) !== 1 ? "s" : ""}
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[ds.confirmBtn, isConfirming && { opacity: 0.5 }]}
                        onPress={() => confirmOrder(order.id, { onSuccess: () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); showToast("Order confirmed!"); refetchPending(); } })}
                        disabled={isConfirming}
                        accessibilityRole="button"
                      >
                        <Ionicons name="checkmark" size={14} color="#fff" />
                        <Text style={ds.confirmText}>Confirm</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
                <Pressable
                  style={ds.viewMore}
                  onPress={() => router.push("/(driver)/orders" as any)}
                >
                  <Text style={ds.viewMoreText}>
                    View all {pendingOrders.length} orders →
                  </Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* ── STATS strip ───────────────────────────────────────────── */}
          {stats && (
            <View style={ds.section}>
              <Text style={ds.label}>My Stats</Text>
              <View style={ds.statsRow}>
                <View style={ds.statBox}>
                  <Text style={ds.statVal}>{stats.totalStopsCompleted ?? 0}</Text>
                  <Text style={ds.statLbl}>Stops</Text>
                </View>
                <View style={ds.statDivider} />
                <View style={ds.statBox}>
                  <Text style={ds.statVal}>
                    {stats.onTimeDeliveryPct != null ? `${Math.round(stats.onTimeDeliveryPct)}%` : "—"}
                  </Text>
                  <Text style={ds.statLbl}>On Time</Text>
                </View>
                <View style={ds.statDivider} />
                <View style={ds.statBox}>
                  <Text style={ds.statVal}>
                    {stats.avgStopsPerRoute != null ? stats.avgStopsPerRoute.toFixed(1) : "—"}
                  </Text>
                  <Text style={ds.statLbl}>Avg / Run</Text>
                </View>
                <View style={ds.statDivider} />
                <View style={ds.statBox}>
                  <Text style={ds.statVal}>
                    {stats.returnsRate != null ? `${(stats.returnsRate * 100).toFixed(1)}%` : "—"}
                  </Text>
                  <Text style={ds.statLbl}>Returns</Text>
                </View>
              </View>
            </View>
          )}

          {/* ── QUICK ACTIONS 3-column grid ───────────────────────────── */}
          <View style={ds.section}>
            <Text style={ds.label}>Quick Actions</Text>
            <View style={ds.grid}>
              {TILES.map((tile) => {
                const disabled = !!tile.runRequired && !primaryRun;
                const path = tile.runRequired ? resolveRunTilePath(tile.id) : (tile.path ?? "");
                return (
                  <Pressable
                    key={tile.id}
                    style={[ds.tile, { width: COL3 }, disabled && ds.tileOff]}
                    onPress={() => { if (!disabled && path) router.push(path as any); }}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={tile.label}
                  >
                    {tile.runRequired && !!primaryRun && <View style={ds.liveDot} />}
                    <View style={[ds.tileIconWrap, { backgroundColor: disabled ? "#f8fafc" : tile.bg }]}>
                      <Ionicons
                        name={tile.icon as any}
                        size={24}
                        color={disabled ? "#cbd5e1" : tile.color}
                      />
                    </View>
                    <Text style={[ds.tileName, disabled && ds.tileNameOff]} numberOfLines={2}>
                      {tile.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* ── RECENT DELIVERIES ─────────────────────────────────────── */}
          {recentOrders.length > 0 && (
            <View style={ds.section}>
              <View style={ds.labelRow}>
                <Text style={ds.label}>Recent Deliveries</Text>
                <Pressable onPress={() => router.push("/(driver)/history" as any)}>
                  <Text style={ds.viewMoreText}>All history →</Text>
                </Pressable>
              </View>
              <View style={ds.card}>
                {recentOrders.map((order: any, idx: number) => (
                  <View key={order.id}>
                    {idx > 0 && <View style={ds.divider} />}
                    <Pressable
                      style={ds.recentRow}
                      onPress={() => router.push(`/(driver)/orders/${order.id}` as any)}
                      accessibilityRole="button"
                      accessibilityLabel={`View delivered order ${order.orderNumber}`}
                    >
                      <View style={ds.recentIcon}>
                        <Ionicons name="checkmark-circle" size={20} color={colors.success.DEFAULT} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={ds.recentOrder}>
                          {order.orderNumber ?? `ORD-${order.id.slice(-5).toUpperCase()}`}
                        </Text>
                        <Text style={ds.recentMeta}>
                          {order.lineItems?.length ?? 0} item{(order.lineItems?.length ?? 0) !== 1 ? "s" : ""} · Delivered
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={14} color="#cbd5e1" />
                    </Pressable>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </>
  );
}

const ds = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface.raised },
  hero: {
    backgroundColor: colors.brand[500],
    paddingTop: 60,
    paddingBottom: 28,
    paddingHorizontal: 20,
  },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  heroDate: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.7)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  heroGreeting: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.4)",
  },
  avatarText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  body: { padding: 16, gap: 8 },
  section: { gap: 8, marginBottom: 8 },
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  scheduleCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  scheduleCtaText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    overflow: "hidden",
    ...shadows.card,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    marginHorizontal: 16,
  },
  // Run cards
  runCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    overflow: "hidden",
    ...shadows.card,
  },
  runCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 8,
  },
  runCardName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  runCardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  runStatusPill: {
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  runStatusActive: { backgroundColor: colors.brand[50] },
  runStatusScheduled: { backgroundColor: "#f1f5f9" },
  runStatusText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.4,
  },
  runMetaText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  runProgress: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 4,
  },
  runProgressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surface.border,
    overflow: "hidden",
  },
  runProgressFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success.DEFAULT,
  },
  runProgressText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  runActions: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 14,
    flexWrap: "wrap",
  },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  runBtnPrimary: { backgroundColor: colors.brand[500] },
  runBtnStart: { backgroundColor: colors.success.DEFAULT },
  runBtnPrimaryText: { fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff" },
  runBtnSecondary: {
    backgroundColor: "#f0fdf4",
    borderWidth: 1,
    borderColor: colors.success.DEFAULT + "50",
  },
  runBtnSecondaryText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.success.DEFAULT,
  },
  runBtnEdit: {
    backgroundColor: colors.brand[50],
    borderWidth: 1,
    borderColor: colors.brand[100] ?? "#dbeafe",
  },
  runBtnEditText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  runBtnCancel: {
    backgroundColor: "#fff1f2",
    borderWidth: 1,
    borderColor: "#fecaca",
  },
  runBtnCancelText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#dc2626",
  },
  // Empty route state
  routeEmpty: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 18,
  },
  routeEmptyTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  routeEmptyMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: 2,
  },
  // Badge
  badge: {
    backgroundColor: "#d97706",
    borderRadius: 10,
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  badgeText: { fontSize: 12, fontFamily: "Inter_700Bold", color: "#fff" },
  // Pending rows
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  pendingPrimary: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  pendingSecondary: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginTop: 2,
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
  confirmText: { fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff" },
  viewMore: {
    padding: 14,
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  viewMoreText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  // Stats
  statsRow: {
    backgroundColor: "#fff",
    borderRadius: 14,
    flexDirection: "row",
    overflow: "hidden",
    ...shadows.card,
  },
  statBox: { flex: 1, alignItems: "center", paddingVertical: 18, gap: 4 },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 40,
    backgroundColor: colors.surface.border,
    alignSelf: "center",
  },
  statVal: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  statLbl: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  // Quick tiles
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 12,
    alignItems: "center",
    gap: 8,
    position: "relative",
    ...shadows.card,
  },
  tileOff: { opacity: 0.38 },
  tileIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tileName: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    textAlign: "center",
  },
  tileNameOff: { color: "#cbd5e1" },
  liveDot: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success.DEFAULT,
  },
  // Recent deliveries
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  recentIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#f0fdf4",
    alignItems: "center",
    justifyContent: "center",
  },
  recentOrder: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  recentMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: 2,
  },
});
