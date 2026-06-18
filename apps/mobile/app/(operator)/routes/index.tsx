import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useAdminDrivers, useAdminRoutes, type AdminDriver } from "../../../lib/api/admin";

function driverDisplayName(driver: AdminDriver | undefined): string {
  if (!driver) return "Unassigned";
  if (driver.user?.firstName || driver.user?.lastName) {
    return `${driver.user.firstName ?? ""} ${driver.user.lastName ?? ""}`.trim();
  }
  return driver.user?.username ?? "Driver";
}

export default function RoutesListScreen() {
  const router = useRouter();
  const { data, isLoading, isFetching, refetch } = useAdminRoutes({ limit: 100 });
  const { data: driversData } = useAdminDrivers();
  const routes = data?.data ?? [];
  const drivers = driversData?.data ?? [];
  const driversById = useMemo(() => {
    const m = new Map<string, AdminDriver>();
    for (const d of drivers) m.set(d.id, d);
    return m;
  }, [drivers]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Routes"
        subtitle={`${routes.length} template${routes.length === 1 ? "" : "s"}`}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction label="Add" bold onPress={() => router.push("/(operator)/routes/new")} />
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : routes.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No routes yet.</Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(operator)/routes/new")}
            >
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Create route</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {routes.map((r) => {
              const driverName = driverDisplayName(
                r.driverId ? driversById.get(r.driverId) : undefined,
              );
              const stopCount = r._count?.stops ?? 0;
              return (
                <Pressable
                  key={r.id}
                  style={styles.row}
                  onPress={() => router.push(`/(operator)/routes/${r.id}`)}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {driverName} · {stopCount} stop{stopCount === 1 ? "" : "s"}
                    </Text>
                  </View>
                  {r.isActive === false ? (
                    <Pill variant="gray">Inactive</Pill>
                  ) : r.driverId ? (
                    <Pill variant="green" dot>
                      Assigned
                    </Pill>
                  ) : (
                    <Pill variant="red">No driver</Pill>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 14 },
  emptyText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  primaryBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  row: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
