import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Path, Rect } from "react-native-svg";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { Pill } from "@routeflow/ui/mobile/ios";
import {
  useAdminDrivers,
  useAdminRoutes,
  type AdminDriver,
} from "../../lib/api/admin";

function driverDisplayName(driver: AdminDriver | undefined): string {
  if (!driver) return "Unassigned";
  if (driver.user?.firstName || driver.user?.lastName) {
    return `${driver.user.firstName ?? ""} ${driver.user.lastName ?? ""}`.trim();
  }
  return driver.user?.username ?? "Driver";
}

function driverInitials(driver: AdminDriver | undefined): string {
  if (!driver?.user) return "—";
  const first = driver.user.firstName?.[0] ?? "";
  const last = driver.user.lastName?.[0] ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}

// UI-shell map backdrop; the live driver list + status pulls real data.
// TODO: wire GPS polylines once /routes/live endpoint exists.
export default function FleetScreen() {
  const router = useRouter();
  const { data: routesData } = useAdminRoutes({ limit: 50 });
  const { data: driversData } = useAdminDrivers();
  const routes = routesData?.data ?? [];
  const driversById = useMemo(() => {
    const map = new Map<string, AdminDriver>();
    for (const d of driversData?.data ?? []) map.set(d.id, d);
    return map;
  }, [driversData]);

  const live = routes.filter((r) => r.runs?.[0]?.status === "IN_PROGRESS");
  const home = routes.filter((r) => r.runs?.[0]?.status === "COMPLETED");

  return (
    <View style={styles.screen}>
      <View style={styles.mapBg}>
        <Svg width="100%" height="100%" viewBox="0 0 393 852" preserveAspectRatio="none">
          <Path d="M-20 180 Q 100 200 200 240 T 420 280" stroke="#fff" strokeWidth={14} fill="none" />
          <Path d="M80 -20 Q 120 200 170 420 T 260 820" stroke="#fff" strokeWidth={12} fill="none" />
          <Path d="M-20 500 Q 120 470 240 510 T 420 540" stroke="#fff" strokeWidth={12} fill="none" />
          <Rect x={40} y={360} width={80} height={50} rx={10} fill="#B9D7B1" opacity={0.7} />
          <Rect x={260} y={420} width={110} height={80} rx={14} fill="#B9D7B1" opacity={0.7} />
          <Path
            d="M-20 820 Q 100 780 200 810 T 420 790 L 420 900 L -20 900 Z"
            fill="#A9C8D2"
            opacity={0.8}
          />
        </Svg>
      </View>

      <SafeAreaView style={styles.overlay} edges={["top", "left", "right"]}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={16} color="#636366" />
          <Text style={styles.searchPlaceholder}>Search driver, route, customer…</Text>
          <Pill variant="green" dot small>
            {live.length} live
          </Pill>
        </View>

        <View style={styles.legend}>
          <LegendChip color={ios.brand} label={`On route · ${live.length}`} />
          <LegendChip color={ios.system.green} label={`Home · ${home.length}`} />
        </View>

        <View style={{ flex: 1 }} />

        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Live drivers</Text>
          </View>

          {routes.length === 0 ? (
            <Text style={styles.empty}>No routes configured.</Text>
          ) : (
            routes.slice(0, 5).map((r, i) => {
              const driver = r.driverId ? driversById.get(r.driverId) : undefined;
              const name = driverDisplayName(driver);
              const initials = driverInitials(driver);
              const runStatus = r.runs?.[0]?.status;
              const stateLabel =
                runStatus === "IN_PROGRESS"
                  ? "On route"
                  : runStatus === "COMPLETED"
                    ? "Home"
                    : "Scheduled";
              const stopCount = r._count?.stops ?? 0;
              return (
                <Pressable
                  key={r.id}
                  onPress={() =>
                    r.driverId
                      ? router.push(
                          `/(operator)/driver?id=${encodeURIComponent(r.driverId)}`,
                        )
                      : null
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
                      {name} <Text style={styles.driverRoute}>· {r.name}</Text>
                    </Text>
                    <Text style={styles.driverProgress}>
                      {stateLabel}
                      {stopCount ? ` · ${stopCount} stop${stopCount === 1 ? "" : "s"}` : ""}
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
  screen: { flex: 1, backgroundColor: "#DCE7E9" },
  mapBg: { ...StyleSheet.absoluteFillObject },
  overlay: { flex: 1, paddingHorizontal: 16 },
  searchBar: {
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 14,
    padding: 10,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    marginTop: 8,
  },
  searchPlaceholder: { flex: 1, fontSize: 15, color: "#636366", fontFamily: "Inter_400Regular" },
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
