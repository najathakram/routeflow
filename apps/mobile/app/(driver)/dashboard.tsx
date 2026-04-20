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
import { SafeAreaView } from "react-native-safe-area-context";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  BrandGradientCard,
  brandGradientStyles,
  InlineStats,
  ListGroup,
  ListRow,
  Pill,
} from "@routeflow/ui/mobile/ios";
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

type Tile = {
  id: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  bg: string;
  color: string;
  path?: string;
  runRequired?: boolean;
};

const TILES: readonly Tile[] = [
  { id: "order",    label: "New Order",     icon: "add-circle-outline",      bg: ios.system.greenWash, color: ios.system.greenInk, path: "/(driver)/orders/new" },
  { id: "customers",label: "Customers",     icon: "people-outline",          bg: ios.system.orangeWash, color: ios.system.orangeInk, path: "/(driver)/customers" },
  { id: "stock",    label: "Stock Check",   icon: "cube-outline",            bg: ios.fill3, color: ios.label, path: "/(driver)/inventory" },
  { id: "schedule", label: "Schedule Run",  icon: "calendar-outline",        bg: ios.brandWash, color: ios.brand, path: "/(driver)/route/new-run" },
  { id: "history",  label: "History",       icon: "time-outline",            bg: ios.fill3, color: ios.label2, path: "/(driver)/history" },
  { id: "perf",     label: "Performance",   icon: "stats-chart-outline",     bg: ios.system.purpleWash, color: ios.system.purpleInk, path: "/(driver)/history/performance" },
  { id: "adjust",   label: "Adjust Stock",  icon: "swap-horizontal-outline", bg: ios.system.orangeWash, color: ios.system.orangeInk, path: "/(driver)/inventory/adjust" },
  { id: "purchase", label: "Purchase Req.", icon: "cart-outline",            bg: ios.system.greenWash, color: ios.system.greenInk, path: "/(driver)/inventory/purchase" },
  { id: "packing",  label: "Packing List",  icon: "list-outline",            bg: ios.brandWash, color: ios.brand, runRequired: true },
  { id: "map",      label: "Route Map",     icon: "map-outline",             bg: ios.brandWash, color: ios.brand, runRequired: true },
  { id: "messages", label: "Messages",      icon: "chatbubble-outline",      bg: ios.brandWash, color: ios.brand, runRequired: true },
  { id: "mileage",  label: "Log Mileage",   icon: "speedometer-outline",     bg: ios.fill3, color: ios.label2, runRequired: true },
];

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

  const handleStart = () =>
    updateStatus({ id: r.id, status: "IN_PROGRESS" }, {
      onError: (err: any) =>
        Alert.alert("Error", err?.response?.data?.message ?? "Could not start run."),
    });

  const handleStop = () =>
    Alert.alert("Complete Route?", "Mark this route as completed?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Complete",
        onPress: () =>
          updateStatus({ id: r.id, status: "COMPLETED" }, {
            onError: (err: any) =>
              Alert.alert("Error", err?.response?.data?.message ?? "Could not complete run."),
          }),
      },
    ]);

  const handleCancel = () =>
    Alert.alert("Cancel Run?", "This will cancel the scheduled run.", [
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
    ]);

  if (isActive) {
    const nextStop =
      stops.find((s) => s.status === "IN_PROGRESS") ??
      stops.find((s) => s.status === "PENDING");
    const pct = totalStops > 0 ? Math.round((completedCount / totalStops) * 100) : 0;
    const remaining = totalStops - completedCount;
    return (
      <BrandGradientCard radius={20} padding={18} style={rs.activeHero}>
        <Text style={brandGradientStyles.eyebrow}>
          {r.route?.name ?? "Route"} · {dateLabel}
        </Text>
        <Text style={brandGradientStyles.title}>
          {remaining} left · {completedCount}/{totalStops} done
        </Text>
        <Text style={brandGradientStyles.subtitle}>
          {pct}% complete
        </Text>
        <View style={rs.heroActionRow}>
          <Pressable
            style={rs.heroPrimary}
            onPress={() => {
              if (nextStop) router.push(`/(driver)/route/stop/${nextStop.id}?runId=${r.id}` as any);
              else router.push("/(driver)/route" as any);
            }}
          >
            <Ionicons name="navigate" size={14} color={ios.brandInk} />
            <Text style={rs.heroPrimaryText}>Next stop</Text>
          </Pressable>
          <Pressable
            style={rs.heroSecondary}
            onPress={handleStop}
            disabled={isPending}
          >
            <Text style={rs.heroSecondaryText}>Complete run</Text>
          </Pressable>
        </View>
      </BrandGradientCard>
    );
  }

  // Scheduled / upcoming — iOS surface card
  return (
    <View style={rs.card}>
      <Pressable
        style={rs.cardHeader}
        onPress={() => router.push("/(driver)/route" as any)}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pill variant="gray" small>{dateLabel}</Pill>
            <Text style={rs.cardMeta}>
              {totalStops} stop{totalStops !== 1 ? "s" : ""}
            </Text>
          </View>
          <Text style={rs.cardName}>{r.route?.name ?? "Route"}</Text>
        </View>
        <Text style={rs.cardChev}>›</Text>
      </Pressable>
      <View style={rs.cardActions}>
        <Pressable
          style={[rs.btn, rs.btnPrimary]}
          onPress={handleStart}
          disabled={isPending}
        >
          {isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="play" size={14} color="#fff" />
          )}
          <Text style={rs.btnPrimaryText}>{isTodayRun ? "Start" : "Start run"}</Text>
        </Pressable>
        <Pressable
          style={[rs.btn, rs.btnSecondary]}
          onPress={() => router.push(`/(driver)/history/${r.id}` as any)}
        >
          <Text style={rs.btnSecondaryText}>Edit</Text>
        </Pressable>
        <Pressable
          style={[rs.btn, rs.btnDestructive]}
          onPress={handleCancel}
          disabled={isPending}
        >
          <Text style={rs.btnDestructiveText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function DashboardScreen() {
  const { data: activeData, refetch: refetchActive } = useActiveRouteRun();
  const { data: scheduledData, refetch: refetchScheduled } = useScheduledRouteRuns();
  const user = useAuthStore((s) => s.user);

  const activeRuns: RouteRun[] = activeData?.data ?? [];
  const scheduledRuns: RouteRun[] = scheduledData?.data ?? [];
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
    await Promise.all([
      refetchActive(),
      refetchScheduled(),
      refetchPending(),
      refetchStats(),
      refetchRecent(),
    ]);
    setRefreshing(false);
  }, [refetchActive, refetchScheduled, refetchPending, refetchStats, refetchRecent]);

  const username = user?.username ?? "Driver";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const todayLabel = format(new Date(), "EEEE · MMMM d").toUpperCase();

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
      <SafeAreaView style={ds.screen} edges={["top"]}>
        <ScrollView
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {/* ── Large-title header with date + avatar ─────────────── */}
          <View style={ds.header}>
            <View style={ds.headerTopRow}>
              <Text style={ds.dateLabel}>{todayLabel}</Text>
              <View style={ds.avatar}>
                <Text style={ds.avatarText}>{initials}</Text>
              </View>
            </View>
            <Text style={ds.greeting}>
              {greeting}, {username}
            </Text>
          </View>

          {/* ── Run hero ───────────────────────────────────────── */}
          <View style={ds.section}>
            <View style={ds.sectionHeader}>
              <Text style={ds.sectionTitle}>
                {activeRuns.length > 0 ? "Today's run" : "Upcoming"}
              </Text>
              <Pressable
                onPress={() => router.push("/(driver)/route/new-run" as any)}
                style={ds.linkRow}
              >
                <Ionicons name="add" size={14} color={ios.brand} />
                <Text style={ds.linkText}>Schedule</Text>
              </Pressable>
            </View>

            {allRuns.length === 0 ? (
              <Pressable
                style={ds.emptyCard}
                onPress={() => router.push("/(driver)/route/new-run" as any)}
              >
                <Ionicons name="calendar-outline" size={28} color={ios.gray[1]} />
                <View style={{ flex: 1 }}>
                  <Text style={ds.emptyTitle}>No routes scheduled</Text>
                  <Text style={ds.emptyMeta}>Tap to schedule a run</Text>
                </View>
                <Text style={ds.emptyChev}>›</Text>
              </Pressable>
            ) : (
              <View style={{ gap: 10 }}>
                {allRuns.map((run) => <RunCard key={run.id} run={run} />)}
              </View>
            )}
          </View>

          {/* ── Stats strip ────────────────────────────────────── */}
          {stats ? (
            <View style={ds.section}>
              <Text style={ds.sectionTitle}>My stats</Text>
              <InlineStats
                stats={[
                  { label: "Stops", value: String(stats.totalStopsCompleted ?? 0) },
                  {
                    label: "On time",
                    value: stats.onTimeDeliveryPct != null ? `${Math.round(stats.onTimeDeliveryPct)}%` : "—",
                    color: ios.system.greenInk,
                  },
                  {
                    label: "Avg/run",
                    value: stats.avgStopsPerRoute != null ? stats.avgStopsPerRoute.toFixed(1) : "—",
                  },
                  {
                    label: "Returns",
                    value: stats.returnsRate != null ? `${(stats.returnsRate * 100).toFixed(1)}%` : "—",
                  },
                ]}
              />
            </View>
          ) : null}

          {/* ── Unconfirmed orders ─────────────────────────────── */}
          {pendingOrders.length > 0 ? (
            <View style={ds.section}>
              <View style={ds.sectionHeader}>
                <Text style={[ds.sectionTitle, { color: ios.system.orangeInk }]}>
                  Unconfirmed · {pendingOrders.length}
                </Text>
              </View>
              <ListGroup>
                {pendingOrders.slice(0, 3).map((order: any) => (
                  <ListRow
                    key={order.id}
                    title={order.orderNumber ?? `ORD-${order.id.slice(-5).toUpperCase()}`}
                    subtitle={`${order.lineItems?.length ?? 0} item${(order.lineItems?.length ?? 0) !== 1 ? "s" : ""}`}
                    trailing={
                      <Pressable
                        style={[ds.confirmBtn, isConfirming && { opacity: 0.5 }]}
                        onPress={() =>
                          confirmOrder(order.id, {
                            onSuccess: () => {
                              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                              showToast("Order confirmed");
                              refetchPending();
                            },
                          })
                        }
                        disabled={isConfirming}
                      >
                        <Ionicons name="checkmark" size={13} color="#fff" />
                        <Text style={ds.confirmText}>Confirm</Text>
                      </Pressable>
                    }
                    onPress={() => router.push(`/(driver)/orders/${order.id}` as any)}
                  />
                ))}
              </ListGroup>
            </View>
          ) : null}

          {/* ── Quick actions grid ─────────────────────────────── */}
          <View style={ds.section}>
            <Text style={ds.sectionTitle}>Quick actions</Text>
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
                  >
                    <View style={[ds.tileIcon, { backgroundColor: tile.bg }]}>
                      <Ionicons
                        name={tile.icon}
                        size={20}
                        color={disabled ? ios.gray[3] : tile.color}
                      />
                    </View>
                    <Text
                      style={[ds.tileName, disabled && { color: ios.gray[3] }]}
                      numberOfLines={2}
                    >
                      {tile.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* ── Recent deliveries ──────────────────────────────── */}
          {recentOrders.length > 0 ? (
            <View style={ds.section}>
              <View style={ds.sectionHeader}>
                <Text style={ds.sectionTitle}>Recent deliveries</Text>
                <Pressable onPress={() => router.push("/(driver)/history" as any)}>
                  <Text style={ds.linkText}>All history</Text>
                </Pressable>
              </View>
              <ListGroup>
                {recentOrders.map((order: any) => (
                  <ListRow
                    key={order.id}
                    icon={<Ionicons name="checkmark" size={15} color={ios.system.greenInk} />}
                    iconBg={ios.system.greenWash}
                    title={order.orderNumber ?? `ORD-${order.id.slice(-5).toUpperCase()}`}
                    subtitle={`${order.lineItems?.length ?? 0} item${(order.lineItems?.length ?? 0) !== 1 ? "s" : ""} · Delivered`}
                    chevron
                    onPress={() => router.push(`/(driver)/orders/${order.id}` as any)}
                  />
                ))}
              </ListGroup>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

const ds = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ios.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
  },
  headerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  dateLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.5,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: ios.brand,
    letterSpacing: -0.2,
  },
  greeting: {
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -1,
    lineHeight: 40,
  },
  section: {
    marginBottom: 20,
    paddingHorizontal: 16,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 10,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  linkText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
  },
  emptyCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 18,
    backgroundColor: ios.bgElev,
    borderRadius: ios.cardRadius,
  },
  emptyTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  emptyMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  emptyChev: {
    fontSize: 22,
    color: ios.gray[3],
    marginRight: -4,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tile: {
    backgroundColor: ios.bgElev,
    borderRadius: ios.cardRadius,
    padding: 12,
    alignItems: "center",
    gap: 8,
    minHeight: 100,
  },
  tileOff: { opacity: 0.4 },
  tileIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tileName: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  confirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.system.green,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  confirmText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});

const rs = StyleSheet.create({
  activeHero: {},
  heroActionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
  },
  heroPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  heroPrimaryText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.brandInk,
  },
  heroSecondary: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  heroSecondaryText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: ios.cardRadius,
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
  },
  cardName: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cardMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  cardChev: {
    fontSize: 22,
    color: ios.gray[3],
  },
  cardActions: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  btnPrimary: {
    flex: 2,
    backgroundColor: ios.brand,
  },
  btnPrimaryText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  btnSecondary: {
    flex: 1,
    backgroundColor: ios.fill3,
  },
  btnSecondaryText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  btnDestructive: {
    flex: 1,
    backgroundColor: ios.system.redWash,
  },
  btnDestructiveText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.red,
  },
});
