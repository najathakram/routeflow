import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  InlineStats,
  KpiCard,
  NavBar,
  Pill,
  ProgressTrack,
  StopCard,
} from "@routeflow/ui/mobile/ios";
import {
  useAdminDashboard,
  useAdminDrivers,
  useAdminRoutes,
  type AdminDriver,
  type AdminRoute,
} from "../../../lib/api/admin";
import {
  useActiveRouteRun,
  useOperatorRouteRuns,
  useScheduledRouteRuns,
  useUpdateRunStatus,
  type RouteRun,
  type RouteRunStop,
} from "../../../lib/api/routes";
import { startLocationTracking } from "../../../lib/location-tracker";
import { useAuthStore } from "../../../lib/auth-store";
import { useDeliveryAccess, useDeveloperMode, useRoutesAccess } from "../../../lib/api/addons";

function routeStatusLabel(r: AdminRoute): {
  label: string;
  variant: "green" | "brand" | "orange" | "red" | "gray";
  pct: number;
} {
  const status = r.runs?.[0]?.status;
  if (status === "IN_PROGRESS") return { label: "On route", variant: "brand", pct: 50 };
  if (status === "COMPLETED") return { label: "Rolled", variant: "green", pct: 100 };
  if (!r.driverId) return { label: "No driver", variant: "red", pct: 0 };
  return { label: "Scheduled", variant: "gray", pct: 0 };
}

function driverDisplayName(driver: AdminDriver | undefined): string {
  if (!driver) return "Unassigned";
  if (driver.user?.firstName || driver.user?.lastName) {
    return `${driver.user.firstName ?? ""} ${driver.user.lastName ?? ""}`.trim();
  }
  return driver.user?.username ?? "Driver";
}

export default function OperatorHomeScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  // Owner split 2026-08-25: the dispatch-readiness hero and "Routes today" are
  // recurring-routes surfaces (useAdminRoutes keeps the SCHEDULED default), so
  // they follow the routes addon; drivers is shared by both features, matching
  // (operator)/_layout.tsx's EITHER_SECTIONS. Owner decision 2026-08-28: the
  // helpers no longer fold in developer_mode — these operator dispatch
  // surfaces follow the feature addons alone.
  const routesAccess = useRoutesAccess();
  const deliveryAccess = useDeliveryAccess();
  const driversAccess = routesAccess.enabled || deliveryAccess.enabled;
  // Drive mode keeps the RAW dev switch: the (driver) app is still gated on
  // developer_mode in app/_layout.tsx, so an addon-only operator has no driver
  // UI to switch into.
  const { enabled: devMode } = useDeveloperMode();
  const [viewMode, setViewMode] = useState<"operator" | "driver">("operator");
  // Non-dev tenants have no driver UI to switch into — force operator
  // regardless of any stale local state, so DriverInlineView can never render.
  const effectiveViewMode = devMode ? viewMode : "operator";
  const { data: stats, isLoading: statsLoading } = useAdminDashboard();
  // `/routes`, `/drivers` and `/route-runs` are addon-gated server-side (403
  // without a dispatch addon), so each query is disabled on the same gate that
  // hides what it feeds — a tenant with neither addon polls nothing. Runs use
  // the either-gate (an ad-hoc delivery materializes a route + run).
  const { data: routesData, isLoading: routesLoading } = useAdminRoutes(
    { limit: 10 },
    { enabled: routesAccess.enabled },
  );
  const { data: driversData } = useAdminDrivers(undefined, { enabled: driversAccess });
  const routes = routesData?.data ?? [];
  const driversById = useMemo(() => {
    const map = new Map<string, AdminDriver>();
    for (const d of driversData?.data ?? []) map.set(d.id, d);
    return map;
  }, [driversData]);

  // Active runs: today's scheduled runs PLUS any run still IN_PROGRESS from a prior day
  const today = new Date().toISOString().slice(0, 10);
  const { data: runsData } = useOperatorRouteRuns(
    { date: today, limit: 50 },
    { enabled: routesAccess.enabled || deliveryAccess.enabled },
  );
  const { data: inProgressData } = useOperatorRouteRuns(
    { status: "IN_PROGRESS", limit: 50 },
    { enabled: routesAccess.enabled || deliveryAccess.enabled },
  );
  const todayRuns = useMemo(() => {
    const seen = new Set<string>();
    const merged: RouteRun[] = [];
    for (const r of [...(runsData?.data ?? []), ...(inProgressData?.data ?? [])]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
      }
    }
    return merged;
  }, [runsData, inProgressData]);

  const initials =
    user?.username
      ?.split(/[._\s]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") ?? "OP";

  const now = new Date();
  const dateLabel = now
    .toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    })
    .toUpperCase();

  // Readiness based on today's runs (same as Dispatch) so both screens agree
  const readiness = useMemo(() => {
    if (todayRuns.length === 0) return { pct: 0, loaded: 0, total: 0 };
    const loaded = todayRuns.filter(
      (r) => r.status === "IN_PROGRESS" || r.status === "COMPLETED",
    ).length;
    return {
      pct: Math.round((loaded / todayRuns.length) * 100),
      loaded,
      total: todayRuns.length,
    };
  }, [todayRuns]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Today"
        subtitle={
          routesLoading ? " " : `${todayRuns.length} run${todayRuns.length === 1 ? "" : "s"} today`
        }
        leading={<Text style={styles.dateEyebrow}>{dateLabel}</Text>}
        trailing={
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Pressable style={styles.navIcon} onPress={() => router.push("/(operator)/exceptions")}>
              <Ionicons name="notifications-outline" size={17} color={ios.label} />
              {stats && stats.returnsToProcess > 0 ? <View style={styles.badge} /> : null}
            </Pressable>
            <Pressable
              style={styles.navAvatar}
              onPress={() => router.push("/(operator)/more")}
              hitSlop={6}
            >
              <Text style={styles.navAvatarText}>{initials}</Text>
            </Pressable>
          </View>
        }
      />

      {/* Mode switcher — local state only, no navigation, header stays fixed */}
      {devMode && user?.canActAsDriver ? (
        <View style={styles.modeBar}>
          <View style={styles.modeTrack}>
            <Pressable
              style={[styles.modeSeg, effectiveViewMode === "operator" && styles.modeSegActive]}
              onPress={() => setViewMode("operator")}
            >
              <Ionicons
                name="briefcase-outline"
                size={14}
                color={effectiveViewMode === "operator" ? ios.brand : ios.label2}
              />
              <Text
                style={[
                  styles.modeLabel,
                  effectiveViewMode === "operator" && styles.modeLabelActive,
                ]}
              >
                Operator
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modeSeg, effectiveViewMode === "driver" && styles.modeSegActive]}
              onPress={() => setViewMode("driver")}
            >
              <Ionicons
                name="car-outline"
                size={14}
                color={effectiveViewMode === "driver" ? ios.brand : ios.label2}
              />
              <Text
                style={[styles.modeLabel, effectiveViewMode === "driver" && styles.modeLabelActive]}
              >
                Driver
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {effectiveViewMode === "driver" ? (
        <DriverInlineView />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Readiness hero */}
          {routesAccess.enabled ? (
            <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
              <LinearGradient
                colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.hero}
              >
                <Text style={styles.heroEyebrow}>DISPATCH READINESS</Text>
                <View style={styles.heroRow}>
                  <Text style={styles.heroValue}>{readiness.pct}%</Text>
                  <Text style={styles.heroSub}>
                    {readiness.loaded} of {readiness.total} runs rolling
                  </Text>
                </View>
                <View style={styles.heroTrack}>
                  <View style={[styles.heroTrackFill, { width: `${readiness.pct}%` }]} />
                </View>
                <View style={styles.heroActions}>
                  <Pressable
                    style={styles.heroBtnFilled}
                    onPress={() => router.push("/(operator)/new-order")}
                  >
                    <Ionicons name="add" size={14} color={ios.brandInk} />
                    <Text style={styles.heroBtnFilledText}>New order</Text>
                  </Pressable>
                  <Pressable
                    style={styles.heroBtnGhost}
                    onPress={() => router.push("/(operator)/dispatch")}
                  >
                    <Text style={styles.heroBtnGhostText}>Dispatch</Text>
                  </Pressable>
                  <Pressable
                    style={styles.heroBtnGhost}
                    onPress={() => router.push("/(operator)/fleet")}
                  >
                    <Text style={styles.heroBtnGhostText}>Fleet</Text>
                  </Pressable>
                </View>
              </LinearGradient>
            </View>
          ) : null}

          {/* KPIs */}
          {statsLoading || !stats ? (
            <View style={styles.kpiLoading}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : (
            <>
              <View style={styles.kpiGrid}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => router.push("/(operator)/orders?status=PENDING")}
                >
                  <KpiCard
                    icon={<Ionicons name="receipt-outline" size={18} color={ios.brand} />}
                    iconBg={ios.brandWash}
                    value={String(stats.pendingOrders)}
                    label="Pending orders"
                  />
                </Pressable>
                {/* Tenants with neither delivery addon have no drivers surface —
                    the grid keeps two cells per row by swapping in a
                    non-dispatch KPI. */}
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() =>
                    router.push(driversAccess ? "/(operator)/drivers" : "/(operator)/customers")
                  }
                >
                  <KpiCard
                    icon={<Ionicons name="people-outline" size={18} color={ios.system.greenInk} />}
                    iconBg={ios.system.greenWash}
                    value={String(driversAccess ? stats.activeDrivers : stats.totalCustomers)}
                    label={driversAccess ? "Active drivers" : "Customers"}
                  />
                </Pressable>
              </View>
              <View style={[styles.kpiGrid, { marginTop: 12 }]}>
                <Pressable style={{ flex: 1 }} onPress={() => router.push("/(operator)/warehouse")}>
                  <KpiCard
                    icon={
                      <Ionicons
                        name="alert-circle-outline"
                        size={18}
                        color={ios.system.orangeInk}
                      />
                    }
                    iconBg={ios.system.orangeWash}
                    value={String(stats.lowStockProducts)}
                    label="Low stock"
                  />
                </Pressable>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => router.push("/(operator)/invoices?status=OVERDUE")}
                >
                  <KpiCard
                    icon={<Ionicons name="card-outline" size={18} color={ios.system.redInk} />}
                    iconBg={ios.system.redWash}
                    value={String(stats.invoicesOverdue)}
                    label="Overdue invoices"
                  />
                </Pressable>
              </View>
            </>
          )}

          {routesAccess.enabled ? (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Routes today</Text>
                <Pressable onPress={() => router.push("/(operator)/dispatch")}>
                  <Text style={styles.sectionLink}>All</Text>
                </Pressable>
              </View>

              {routesLoading ? (
                <View style={styles.center}>
                  <ActivityIndicator color={ios.brand} />
                </View>
              ) : routes.length === 0 ? (
                <View style={styles.center}>
                  <Text style={styles.emptyTitle}>No routes scheduled</Text>
                </View>
              ) : (
                <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 20 }}>
                  {routes.slice(0, 6).map((r) => {
                    const driverName = driverDisplayName(
                      r.driverId ? driversById.get(r.driverId) : undefined,
                    );
                    const status = routeStatusLabel(r);
                    const badgeColor =
                      status.variant === "green"
                        ? ios.system.green
                        : status.variant === "brand"
                          ? ios.brand
                          : status.variant === "orange"
                            ? ios.system.orange
                            : status.variant === "red"
                              ? ios.system.red
                              : ios.gray[3];
                    const stopCount = r._count?.stops ?? 0;
                    const activeRun = r.runs?.[0];
                    const cardDest = activeRun
                      ? (`/(operator)/route-runs/${activeRun.id}` as any)
                      : (`/(operator)/routes/${r.id}` as any);
                    return (
                      <Pressable
                        key={r.id}
                        style={styles.routeCard}
                        onPress={() => router.push(cardDest)}
                      >
                        <View style={styles.routeHead}>
                          <View style={[styles.routeBadge, { backgroundColor: badgeColor }]}>
                            <Text style={styles.routeBadgeText}>
                              {r.name?.slice(0, 2)?.toUpperCase() ?? "R"}
                            </Text>
                          </View>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.routeName} numberOfLines={1}>
                              {r.name} · {driverName}
                            </Text>
                            <Text style={styles.routeMeta}>
                              {stopCount} stop{stopCount === 1 ? "" : "s"}
                            </Text>
                          </View>
                          <Pill variant={status.variant} dot>
                            {status.label}
                          </Pill>
                        </View>
                        <View style={styles.routeProgress}>
                          <View style={{ flex: 1 }}>
                            <ProgressTrack
                              percent={status.pct}
                              fill={
                                status.variant === "brand"
                                  ? "brand"
                                  : status.variant === "green"
                                    ? "green"
                                    : status.variant === "red"
                                      ? "red"
                                      : "orange"
                              }
                            />
                          </View>
                          <Text style={styles.routePct}>{status.pct}%</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Driver inline view (shown when mode = "driver") ─────────────────────────

function formatDriverStopSub(stop: RouteRunStop): string {
  const parts: string[] = [];
  if (stop.customerAddress?.line1) parts.push(stop.customerAddress.line1);
  const itemCount = (stop.orders ?? []).reduce((t, o) => t + (o.lineItems?.length ?? 0), 0);
  if (itemCount) parts.push(`${itemCount} item${itemCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function DriverInlineView() {
  const router = useRouter();
  const setActiveRole = useAuthStore((s) => s.setActiveRole);
  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  const { data: scheduledData, isLoading: scheduledLoading } = useScheduledRouteRuns();
  const updateStatus = useUpdateRunStatus();

  const active: RouteRun | null = (activeData?.data?.[0] as RouteRun) ?? null;
  const upcoming: RouteRun | null = (scheduledData?.data?.[0] as RouteRun) ?? null;

  if (activeLoading || scheduledLoading) {
    return (
      <View style={styles.driverCenter}>
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }

  if (active) {
    const stops = active.stops ?? [];
    const done = stops.filter((s) => s.status === "COMPLETED" || s.status === "SKIPPED").length;
    const remaining = stops
      .filter((s) => s.status === "PENDING" || s.status === "IN_PROGRESS")
      .sort((a, b) => a.stopNumber - b.stopNumber);
    const nextStop = remaining[0] ?? null;
    const pct = stops.length ? Math.round((done / stops.length) * 100) : 0;

    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <InlineStats
            stats={[
              { value: String(stops.length), label: "Stops" },
              { value: String(done), label: "Done", color: ios.system.greenInk },
              { value: String(remaining.length), label: "Left", color: ios.brand },
            ]}
          />
          <View style={styles.driverProgressRow}>
            <View style={{ flex: 1 }}>
              <ProgressTrack percent={pct} fill="green" />
            </View>
            <Text style={styles.driverProgressText}>{pct}%</Text>
          </View>
        </View>

        {nextStop ? (
          <View style={{ padding: 16, paddingTop: 8 }}>
            <LinearGradient
              colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.driverHeroCard}
            >
              <Text style={styles.heroEyebrow}>UP NEXT · STOP {nextStop.stopNumber}</Text>
              <Text style={styles.driverHeroTitle}>
                {nextStop.customer?.businessName ?? "Stop"}
              </Text>
              {nextStop.customerAddress?.line1 ? (
                <Text style={styles.heroSub}>{nextStop.customerAddress.line1}</Text>
              ) : null}
              <View style={styles.heroActions}>
                <Pressable
                  style={[styles.heroBtnGhost, { flex: 1, alignItems: "center" }]}
                  onPress={() => {
                    setActiveRole("driver");
                    router.push(`/(driver)/route/stop/${nextStop.id}` as any);
                  }}
                >
                  <Text style={styles.heroBtnGhostText}>Open stop</Text>
                </Pressable>
              </View>
            </LinearGradient>
          </View>
        ) : done > 0 ? (
          <View style={{ padding: 16, paddingTop: 8 }}>
            <View
              style={[
                styles.driverHeroCard,
                { backgroundColor: ios.system.greenInk, alignItems: "center", gap: 6 },
              ]}
            >
              <Ionicons name="checkmark-circle" size={28} color="#fff" />
              <Text style={styles.driverHeroTitle}>All stops done!</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Stops</Text>
        </View>
        <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
          {stops.map((stop) => (
            <StopCard
              key={stop.id}
              number={stop.stopNumber}
              name={stop.customer?.businessName ?? "Stop"}
              subtitle={formatDriverStopSub(stop)}
              status={
                stop.status === "COMPLETED" || stop.status === "SKIPPED"
                  ? "done"
                  : stop.id === nextStop?.id
                    ? "next"
                    : "pending"
              }
              pillLabel={
                stop.status === "COMPLETED"
                  ? "Delivered"
                  : stop.status === "SKIPPED"
                    ? "Skipped"
                    : stop.id === nextStop?.id
                      ? "Up next"
                      : undefined
              }
              onPress={() => {
                setActiveRole("driver");
                router.push(`/(driver)/route/stop/${stop.id}` as any);
              }}
            />
          ))}
        </View>
      </ScrollView>
    );
  }

  if (upcoming) {
    const stopCount = upcoming.stops?.length ?? 0;
    // NEW-rweb-7: parse only the date portion as a local date to avoid UTC-offset shift.
    const dateLabel = new Date((upcoming.scheduledDate ?? "").slice(0, 10).replace(/-/g, "/"))
      .toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
      .toUpperCase();

    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={[styles.dateEyebrow, { paddingHorizontal: 20, paddingTop: 12 }]}>
          {dateLabel}
        </Text>
        <View style={{ padding: 16, paddingTop: 8 }}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.driverHeroCard}
          >
            <Text style={styles.heroEyebrow}>
              {(upcoming.route?.name ?? "ROUTE").toUpperCase()}
            </Text>
            <Text style={styles.driverHeroTitle}>
              {stopCount} stop{stopCount === 1 ? "" : "s"} · ready to depart
            </Text>
            <View style={styles.heroActions}>
              <Pressable
                style={styles.heroBtnFilled}
                disabled={updateStatus.isPending}
                onPress={() =>
                  updateStatus.mutate(
                    { id: upcoming.id, status: "IN_PROGRESS" },
                    { onSuccess: () => void startLocationTracking(upcoming.id) },
                  )
                }
              >
                <Ionicons name="play" size={14} color={ios.brandInk} />
                <Text style={styles.heroBtnFilledText}>
                  {updateStatus.isPending ? "Starting…" : "Start day"}
                </Text>
              </Pressable>
            </View>
          </LinearGradient>
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.driverCenter}>
      <Ionicons name="map-outline" size={40} color={ios.label3} />
      <Text style={styles.emptyTitle}>No route today</Text>
      <Text style={styles.driverEmptySub}>Check back with dispatch for your schedule.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { alignItems: "center", justifyContent: "center", padding: 24, gap: 6 },
  // ── Mode switcher ─────────────────────────────────────────────────────────
  modeBar: { paddingHorizontal: 16, paddingBottom: 10 },
  modeTrack: {
    flexDirection: "row",
    backgroundColor: ios.fill3,
    borderRadius: 12,
    padding: 3,
    gap: 2,
  },
  modeSeg: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 8,
    borderRadius: 10,
  },
  modeSegActive: {
    backgroundColor: ios.bgElev,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  modeLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  modeLabelActive: { color: ios.label, fontFamily: "Inter_600SemiBold" },
  // ─────────────────────────────────────────────────────────────────────────
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label2 },
  dateEyebrow: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  navIcon: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: ios.system.red,
  },
  navAvatar: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  navAvatarText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  hero: { borderRadius: 20, padding: 18, overflow: "hidden" },
  heroEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: "rgba(255,255,255,0.8)",
    letterSpacing: 1.2,
  },
  heroRow: { flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 4 },
  heroValue: {
    fontSize: 42,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -1.2,
    fontVariant: ["tabular-nums"],
  },
  heroSub: { fontSize: 14, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.85)" },
  heroTrack: {
    height: 6,
    backgroundColor: "rgba(255,255,255,0.24)",
    borderRadius: 999,
    marginTop: 12,
    overflow: "hidden",
  },
  heroTrackFill: { height: "100%", backgroundColor: "#fff", borderRadius: 999 },
  heroActions: { flexDirection: "row", gap: 6, marginTop: 14 },
  heroBtnFilled: {
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  heroBtnFilledText: { color: ios.brandInk, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  heroBtnGhost: {
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  heroBtnGhostText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  kpiGrid: { flexDirection: "row", gap: 12, paddingHorizontal: 16, marginTop: 14 },
  kpiLoading: { padding: 24, alignItems: "center" },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  sectionLink: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.brand },
  routeCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    paddingHorizontal: 14,
  },
  routeHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  routeBadgeText: { color: "#fff", fontSize: 12, fontFamily: "Inter_700Bold" },
  routeName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  routeMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  routeProgress: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
  routePct: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    minWidth: 34,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  // ── Driver inline view ────────────────────────────────────────────────────
  driverCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 40,
  },
  driverEmptySub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  driverHeroCard: { borderRadius: 20, padding: 18, overflow: "hidden" },
  driverHeroTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    letterSpacing: -0.4,
    marginTop: 4,
  },
  driverProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    marginBottom: 4,
  },
  driverProgressText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    minWidth: 34,
    textAlign: "right",
  },
});
