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
import type { GestureResponderEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useAdminDrivers, useAdminRoutes, type AdminDriver } from "../../../lib/api/admin";
import { useDeleteRoute } from "../../../lib/api/routes";
import { confirm } from "../../../lib/confirm";
import { showToast } from "../../../lib/toast";

function driverDisplayName(driver: AdminDriver | undefined): string {
  if (!driver) return "Unassigned";
  if (driver.user?.firstName || driver.user?.lastName) {
    return `${driver.user.firstName ?? ""} ${driver.user.lastName ?? ""}`.trim();
  }
  return driver.user?.username ?? "Driver";
}

/**
 * Minimal list of ad-hoc (Route.kind = ADHOC) trips. Rows push into the
 * existing route-detail screen (dispatch/optimize/delete already work there
 * for any route kind) — this screen only adds the "Draft" pill for a trip
 * that was created but never dispatched, plus a quick delete for cleaning up
 * an abandoned builder session, since a draft route has zero orders attached
 * and is safe to discard. The delete affordance is rendered ONLY for drafts —
 * once a trip has a run, deleting it would destroy that run's stops (POD
 * photos, signature, arrival times), which for an ad-hoc trip is the only
 * delivery record its orders have.
 */
export default function TripsListScreen() {
  const router = useRouter();
  const { data, isLoading, isFetching, refetch } = useAdminRoutes({ kind: "ADHOC", limit: 100 });
  const { data: driversData } = useAdminDrivers();
  const deleteMut = useDeleteRoute();
  const routes = data?.data ?? [];
  const drivers = driversData?.data ?? [];
  const driversById = useMemo(() => {
    const m = new Map<string, AdminDriver>();
    for (const d of drivers) m.set(d.id, d);
    return m;
  }, [drivers]);

  const handleDelete = (id: string, name: string) => {
    confirm(
      "Delete trip?",
      `"${name}" and its stops will be removed. This cannot be undone.`,
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Trip deleted");
            refetch();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Deliveries"
        subtitle={`${routes.length} deliver${routes.length === 1 ? "y" : "ies"}`}
        leading={<NavBackButton label="Dispatch" onPress={() => router.back()} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
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
            <Text style={styles.emptyText}>Past deliveries will appear here.</Text>
            <Text style={styles.emptySub}>Plan one from the Orders tab.</Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(operator)/(tabs)/orders")}
            >
              <Ionicons name="arrow-forward" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Go to Orders</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingTop: 8 }}>
            {routes.map((r) => {
              const driverName = driverDisplayName(
                r.driverId ? driversById.get(r.driverId) : undefined,
              );
              const stopCount = r._count?.stops ?? 0;
              const latestRun = r.runs?.[0];
              const runVariant =
                latestRun?.status === "COMPLETED"
                  ? "green"
                  : latestRun?.status === "IN_PROGRESS"
                    ? "orange"
                    : latestRun?.status === "CANCELLED"
                      ? "gray"
                      : "brand";
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
                  {!latestRun ? (
                    <Pill variant="gray">Draft</Pill>
                  ) : (
                    <Pill variant={runVariant as any}>
                      {latestRun.status.replace("_", " ").toLowerCase()}
                    </Pill>
                  )}
                  {!latestRun && (
                    <Pressable
                      style={styles.deleteBtn}
                      hitSlop={8}
                      onPress={(e: GestureResponderEvent) => {
                        e.stopPropagation();
                        handleDelete(r.id, r.name);
                      }}
                    >
                      <Ionicons name="trash-outline" size={18} color={ios.system.red} />
                    </Pressable>
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
  center: { padding: 40, alignItems: "center", gap: 6 },
  emptyText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
  emptySub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    textAlign: "center",
  },
  primaryBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    marginTop: 4,
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
  deleteBtn: {
    width: ios.rowMinH,
    height: ios.rowMinH,
    alignItems: "center",
    justifyContent: "center",
  },
});
