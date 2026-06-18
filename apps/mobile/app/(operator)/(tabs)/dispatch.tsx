import * as React from "react";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { GestureResponderEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBar, Pill, SegmentedControl } from "@routeflow/ui/mobile/ios";
import {
  useAdminDrivers,
  useAdminRoutes,
  type AdminDriver,
  type AdminRoute,
} from "../../../lib/api/admin";
import { useOperatorRouteRuns, type RouteRun } from "../../../lib/api/routes";

function driverDisplayName(driver: AdminDriver | undefined): string {
  if (!driver) return "Unassigned";
  if (driver.user?.firstName || driver.user?.lastName) {
    return `${driver.user.firstName ?? ""} ${driver.user.lastName ?? ""}`.trim();
  }
  return driver.user?.username ?? "Driver";
}

export default function DispatchScreen() {
  const router = useRouter();
  const [tab, setTab] = useState("Routes");
  const { data: routesData, isLoading: routesLoading } = useAdminRoutes({ limit: 50 });
  const { data: driversData, isLoading: driversLoading } = useAdminDrivers();

  const routes = routesData?.data ?? [];
  const drivers = driversData?.data ?? [];
  const driversById = useMemo(() => {
    const map = new Map<string, AdminDriver>();
    for (const d of drivers) map.set(d.id, d);
    return map;
  }, [drivers]);

  const unassigned = routes.filter((r) => !r.driverId);
  const today = new Date().toISOString().slice(0, 10);
  const { data: runsData, isLoading: runsLoading } = useOperatorRouteRuns({
    date: today,
    limit: 50,
  });
  const runs = runsData?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Dispatch"
        inlineTitle="Assign"
        trailing={
          <NavAction label="+ New" bold onPress={() => router.push("/(operator)/new-order")} />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <SegmentedControl items={["Routes", "Drivers"]} value={tab} onChange={setTab} />
        </View>

        {tab === "Routes" ? (
          <RoutesTab
            routes={routes}
            unassigned={unassigned}
            loading={routesLoading}
            driversById={driversById}
            runs={runs}
            runsLoading={runsLoading}
          />
        ) : (
          <DriversTab drivers={drivers} loading={driversLoading} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function RoutesTab({
  routes,
  unassigned,
  loading,
  driversById,
  runs,
  runsLoading,
}: {
  routes: AdminRoute[];
  unassigned: AdminRoute[];
  loading: boolean;
  driversById: Map<string, AdminDriver>;
  runs: RouteRun[];
  runsLoading: boolean;
}) {
  const router = useRouter();
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }
  return (
    <View>
      {unassigned.length > 0 ? (
        <View style={styles.warn}>
          <Ionicons name="alert-circle-outline" size={16} color={ios.system.redInk} />
          <Text style={styles.warnText}>
            {unassigned.length} route{unassigned.length === 1 ? "" : "s"} without a driver
          </Text>
        </View>
      ) : null}

      <SectionHeader title="Today's runs" />
      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 4 }}>
        {runsLoading ? (
          <ActivityIndicator color={ios.brand} style={{ paddingVertical: 20 }} />
        ) : runs.length === 0 ? (
          <Text style={styles.empty}>No runs scheduled today.</Text>
        ) : (
          runs.map((r) => {
            const stopsTotal = r.stops?.length ?? 0;
            const stopsDone = (r.stops ?? []).filter((s) => s.status === "COMPLETED").length;
            const pillVariant =
              r.status === "COMPLETED"
                ? "green"
                : r.status === "IN_PROGRESS"
                  ? "orange"
                  : r.status === "CANCELLED"
                    ? "gray"
                    : "brand";
            return (
              <Pressable
                key={r.id}
                style={styles.routeRow}
                onPress={() => router.push(`/(operator)/route-runs/${r.id}` as any)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.routeName}>{r.route?.name ?? "Run"}</Text>
                  <Text style={styles.routeSub}>
                    {r.driver?.contactName ?? "Unassigned"} · {stopsDone}/{stopsTotal} stops
                  </Text>
                </View>
                <Pill variant={pillVariant as any}>{r.status.replace("_", " ").toLowerCase()}</Pill>
              </Pressable>
            );
          })
        )}
      </View>

      <SectionHeader
        title="All routes"
        action={
          <Pressable onPress={() => router.push("/(operator)/routes/new")}>
            <Text style={styles.sectionAction}>+ New route</Text>
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 20 }}>
        {routes.length === 0 ? (
          <Text style={styles.empty}>No routes defined yet.</Text>
        ) : (
          routes.map((r) => {
            const stopCount = r._count?.stops ?? 0;
            const driverName = driverDisplayName(
              r.driverId ? driversById.get(r.driverId) : undefined,
            );
            return (
              <Pressable
                key={r.id}
                style={styles.routeRow}
                onPress={() => router.push(`/(operator)/routes/${r.id}`)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.routeName}>{r.name}</Text>
                  <Text style={styles.routeSub}>
                    {driverName}
                    {" · "}
                    {stopCount} stop{stopCount === 1 ? "" : "s"}
                  </Text>
                </View>
                {r.driverId ? (
                  <Pill variant="green" dot>
                    Assigned
                  </Pill>
                ) : (
                  <Pressable
                    onPress={(e: GestureResponderEvent) => {
                      e.stopPropagation();
                      router.push(`/(operator)/routes/${r.id}/assign-driver`);
                    }}
                    style={styles.assignBtn}
                  >
                    <Text style={styles.assignBtnText}>Assign</Text>
                  </Pressable>
                )}
              </Pressable>
            );
          })
        )}
      </View>
    </View>
  );
}

function DriversTab({ drivers, loading }: { drivers: AdminDriver[]; loading: boolean }) {
  const router = useRouter();
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }
  return (
    <View>
      <SectionHeader
        title="Drivers"
        action={
          <Pressable onPress={() => router.push("/(operator)/drivers/new")}>
            <Text style={styles.sectionAction}>+ New driver</Text>
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 20 }}>
        {drivers.length === 0 ? (
          <Text style={styles.empty}>No drivers on this tenant.</Text>
        ) : (
          drivers.map((d) => {
            const name = d.user ? `${d.user.firstName} ${d.user.lastName}` : "Unknown driver";
            const initials = d.user
              ? `${d.user.firstName?.[0] ?? ""}${d.user.lastName?.[0] ?? ""}`.toUpperCase()
              : "??";
            return (
              <Pressable
                key={d.id}
                style={styles.driverRow}
                onPress={() => router.push(`/(operator)/driver?id=${encodeURIComponent(d.id)}`)}
              >
                <View style={[styles.avatar, { backgroundColor: ios.brand }]}>
                  <Text style={styles.avatarText}>{initials}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.driverName}>{name}</Text>
                  <Text style={styles.driverStatus}>
                    {d.vehicleMake ? `${d.vehicleMake} ${d.vehicleModel ?? ""}` : d.status}
                  </Text>
                </View>
                <Pill variant={d.status === "ACTIVE" ? "green" : "gray"}>
                  {d.status.toLowerCase()}
                </Pill>
              </Pressable>
            );
          })
        )}
      </View>
    </View>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
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
    padding: 20,
  },
  warn: {
    marginHorizontal: 16,
    marginTop: 14,
    padding: 10,
    paddingHorizontal: 14,
    backgroundColor: ios.system.redWash,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,59,48,0.3)",
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  warnText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.system.redInk,
    flex: 1,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  routeRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  routeName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  routeSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  driverRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 14, fontFamily: "Inter_700Bold" },
  driverName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  driverStatus: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  sectionAction: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  assignBtn: {
    backgroundColor: ios.brand,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  assignBtnText: { color: "#fff", fontSize: 12, fontFamily: "Inter_600SemiBold" },
});
