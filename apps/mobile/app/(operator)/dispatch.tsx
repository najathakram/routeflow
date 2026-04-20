import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { NavBar, Pill, SegmentedControl } from "@routeflow/ui/mobile/ios";
import {
  useAdminDrivers,
  useAdminRoutes,
  type AdminDriver,
  type AdminRoute,
} from "../../lib/api/admin";

export default function DispatchScreen() {
  const [tab, setTab] = useState("Routes");
  const { data: routesData, isLoading: routesLoading } = useAdminRoutes({ limit: 50 });
  const { data: driversData, isLoading: driversLoading } = useAdminDrivers();

  const routes = routesData?.data ?? [];
  const drivers = driversData?.data ?? [];

  const unassigned = routes.filter((r) => !r.driverId);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="Dispatch" inlineTitle="Assign" />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <SegmentedControl
            items={["Routes", "Drivers"]}
            value={tab}
            onChange={setTab}
          />
        </View>

        {tab === "Routes" ? (
          <RoutesTab routes={routes} unassigned={unassigned} loading={routesLoading} />
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
}: {
  routes: AdminRoute[];
  unassigned: AdminRoute[];
  loading: boolean;
}) {
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

      <SectionHeader title="All routes" />
      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 20 }}>
        {routes.length === 0 ? (
          <Text style={styles.empty}>No routes defined yet.</Text>
        ) : (
          routes.map((r) => (
            <View key={r.id} style={styles.routeRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.routeName}>{r.name}</Text>
                <Text style={styles.routeSub}>
                  {r.driver?.user
                    ? `${r.driver.user.firstName} ${r.driver.user.lastName}`
                    : "Unassigned"}
                  {" · "}
                  {r.stops?.length ?? 0} stop{(r.stops?.length ?? 0) === 1 ? "" : "s"}
                </Text>
              </View>
              {r.driverId ? (
                <Pill variant="green" dot>
                  Assigned
                </Pill>
              ) : (
                <Pill variant="red">No driver</Pill>
              )}
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function DriversTab({
  drivers,
  loading,
}: {
  drivers: AdminDriver[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }
  return (
    <View>
      <SectionHeader title="Drivers" />
      <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 20 }}>
        {drivers.length === 0 ? (
          <Text style={styles.empty}>No drivers on this tenant.</Text>
        ) : (
          drivers.map((d) => {
            const name = d.user
              ? `${d.user.firstName} ${d.user.lastName}`
              : "Unknown driver";
            const initials = d.user
              ? `${d.user.firstName?.[0] ?? ""}${d.user.lastName?.[0] ?? ""}`.toUpperCase()
              : "??";
            return (
              <View key={d.id} style={styles.driverRow}>
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
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
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
});
