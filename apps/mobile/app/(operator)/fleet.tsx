import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { Pill } from "@routeflow/ui/mobile/ios";
import { useAdminDrivers, useAdminRoutes, type AdminDriver } from "../../lib/api/admin";
import { useRoutesLive } from "../../lib/api/routes";
import { AppMapView, type MapPin, type MapPolyline } from "../../components/MapView";

function driverInitials(name: string | null | undefined): string {
  if (!name) return "—";
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

function driverDisplayName(driver: AdminDriver | undefined): string {
  if (!driver) return "Unassigned";
  if (driver.user?.firstName || driver.user?.lastName) {
    return `${driver.user.firstName ?? ""} ${driver.user.lastName ?? ""}`.trim();
  }
  return driver.user?.username ?? "Driver";
}

export default function FleetScreen() {
  const router = useRouter();
  const { data: routesData } = useAdminRoutes({ limit: 50 });
  const { data: driversData } = useAdminDrivers();
  const { data: liveData } = useRoutesLive();

  const routes = routesData?.data ?? [];
  const liveRoutes = liveData?.routes ?? [];
  const driversById = useMemo(() => {
    const map = new Map<string, AdminDriver>();
    for (const d of driversData?.data ?? []) map.set(d.id, d);
    return map;
  }, [driversData]);

  // Build map markers + polylines from live data.
  const { pins, polylines } = useMemo(() => {
    const pinList: MapPin[] = [];
    const lineList: MapPolyline[] = [];

    for (const r of liveRoutes) {
      // Driver pin (latest known location)
      if (r.latestLocation) {
        pinList.push({
          id: `driver-${r.driverId ?? r.runId}`,
          lat: r.latestLocation.lat,
          lng: r.latestLocation.lng,
          title: r.driverName ?? "Driver",
          subtitle: r.routeName,
          color: "brand",
          onPress: () =>
            r.driverId
              ? router.push(`/(operator)/driver?id=${encodeURIComponent(r.driverId)}`)
              : undefined,
        });
      }

      // Stop pins for remaining stops
      const remainingStops = r.stops.filter(
        (s) =>
          s.lat != null && s.lng != null && (s.status === "PENDING" || s.status === "IN_PROGRESS"),
      );
      for (const s of remainingStops) {
        pinList.push({
          id: `stop-${s.id}`,
          lat: s.lat as number,
          lng: s.lng as number,
          title: `${s.stopNumber}. ${s.customerName}`,
          color: s.status === "IN_PROGRESS" ? "orange" : "gray",
          onPress: () => router.push(`/(operator)/customers/${s.customerId}`),
        });
      }

      // Polyline through remaining stops
      if (remainingStops.length >= 2) {
        const coords = remainingStops.map((s) => ({ lat: s.lat as number, lng: s.lng as number }));
        // Optionally prepend the driver's current location to draw the next leg
        if (r.latestLocation) {
          coords.unshift({ lat: r.latestLocation.lat, lng: r.latestLocation.lng });
        }
        lineList.push({
          id: `route-${r.runId}`,
          coordinates: coords,
          color: ios.brand,
          width: 4,
        });
      }
    }
    return { pins: pinList, polylines: lineList };
  }, [liveRoutes, router]);

  const liveCount = liveRoutes.length;
  const driversWithLoc = liveRoutes.filter((r) => r.latestLocation != null).length;
  const home = routes.filter((r) => r.runs?.[0]?.status === "COMPLETED");

  return (
    <View style={styles.screen}>
      <View style={styles.mapBg}>
        {pins.length > 0 ? (
          <AppMapView pins={pins} polylines={polylines} fitToPins />
        ) : (
          <View style={styles.mapEmpty}>
            <Ionicons name="map-outline" size={48} color={ios.label3} />
            <Text style={styles.mapEmptyText}>
              No active routes right now. Live driver pins will appear when a route is in progress.
            </Text>
          </View>
        )}
      </View>

      <SafeAreaView
        style={styles.overlay}
        edges={["top", "left", "right"]}
        pointerEvents="box-none"
      >
        <View style={styles.topRow}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={20} color={ios.label} />
          </Pressable>
          <View style={styles.topChip}>
            <Pill variant="green" dot small>
              {liveCount} live
            </Pill>
            <Pill variant="brand" small>
              {driversWithLoc} driver{driversWithLoc === 1 ? "" : "s"} sharing GPS
            </Pill>
          </View>
        </View>

        <View style={styles.legend}>
          <LegendChip color={ios.brand} label={`On route · ${liveCount}`} />
          <LegendChip color={ios.system.green} label={`Home · ${home.length}`} />
        </View>

        <View style={{ flex: 1 }} />

        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Live drivers</Text>
          </View>

          {liveRoutes.length === 0 ? (
            <Text style={styles.empty}>No drivers on the road right now.</Text>
          ) : (
            liveRoutes.slice(0, 6).map((r, i) => {
              const driver = r.driverId ? driversById.get(r.driverId) : undefined;
              const name = r.driverName ?? driverDisplayName(driver);
              const initials = driverInitials(name);
              const stopCount = r.stops.length;
              const remaining = r.stops.filter(
                (s) => s.status === "PENDING" || s.status === "IN_PROGRESS",
              ).length;
              return (
                <Pressable
                  key={r.runId}
                  onPress={() =>
                    r.driverId
                      ? router.push(`/(operator)/driver?id=${encodeURIComponent(r.driverId)}`)
                      : undefined
                  }
                  style={[
                    styles.driverRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: "rgba(60,60,67,0.12)",
                    },
                  ]}
                >
                  <View style={[styles.avatar, { backgroundColor: ios.brand }]}>
                    <Text style={styles.avatarText}>{initials}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.driverName} numberOfLines={1}>
                      {name} <Text style={styles.driverRoute}>· {r.routeName}</Text>
                    </Text>
                    <Text style={styles.driverProgress}>
                      {remaining}/{stopCount} stops left
                      {r.latestLocation
                        ? ` · ${Math.round((Date.now() - new Date(r.latestLocation.recordedAt).getTime()) / 1000)}s ago`
                        : " · waiting on GPS"}
                    </Text>
                  </View>
                  <View style={styles.msgBtn}>
                    <Ionicons name="chevron-forward" size={15} color={ios.brand} />
                  </View>
                </Pressable>
              );
            })
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendChip}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ios.fill3 },
  mapBg: { ...StyleSheet.absoluteFillObject },
  mapEmpty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  mapEmptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  overlay: { flex: 1, paddingHorizontal: 16 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.94)",
    alignItems: "center",
    justifyContent: "center",
  },
  topChip: {
    flexDirection: "row",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.94)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  legend: { flexDirection: "row", gap: 6, marginTop: 12, flexWrap: "wrap" },
  legendChip: {
    backgroundColor: "rgba(255,255,255,0.94)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: { width: 8, height: 8, borderRadius: 999 },
  legendText: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#000" },
  sheet: {
    backgroundColor: "rgba(255,255,255,0.98)",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    marginHorizontal: -6,
    marginBottom: 10,
    paddingBottom: 16,
    paddingTop: 12,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -6 },
    elevation: 6,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: "#D1D1D6",
    alignSelf: "center",
    marginBottom: 10,
  },
  sheetHead: { paddingHorizontal: 16, paddingBottom: 10 },
  sheetTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#000",
    letterSpacing: -0.3,
  },
  empty: {
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#636366",
    paddingVertical: 16,
  },
  driverRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  driverName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#000" },
  driverRoute: { color: "#636366", fontFamily: "Inter_500Medium", fontSize: 13 },
  driverProgress: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#636366", marginTop: 1 },
  msgBtn: {
    width: 34,
    height: 34,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
});
