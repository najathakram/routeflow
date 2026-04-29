import { useMemo } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  InlineStats,
  NavAction,
  NavBackButton,
  NavBar,
} from "@routeflow/ui/mobile/ios";
import { useAdminDrivers, useAdminRoutes } from "../../lib/api/admin";

export default function OperatorDriverDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const driverId = params?.id;

  const { data: driversData, isLoading: driversLoading } = useAdminDrivers();
  const { data: routesData } = useAdminRoutes({ limit: 50 });

  const driver = useMemo(
    () => driversData?.data?.find((d) => d.id === driverId) ?? null,
    [driversData, driverId],
  );
  const driverRoutes = useMemo(
    () => (routesData?.data ?? []).filter((r) => r.driverId === driverId),
    [routesData, driverId],
  );

  if (driversLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Driver"
          leading={<NavBackButton label="Fleet" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!driver) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Driver"
          leading={<NavBackButton label="Fleet" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Driver not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const name = driver.user
    ? ([driver.user.firstName, driver.user.lastName].filter(Boolean).join(" ") || driver.user.username || "Driver")
    : "Unknown driver";
  const initials = driver.user
    ? `${driver.user.firstName?.[0] ?? ""}${driver.user.lastName?.[0] ?? ""}`.toUpperCase()
    : "??";
  const activeRoute = driverRoutes.find((r) => r.runs?.[0]?.status === "IN_PROGRESS");
  const activeRouteName = activeRoute?.name ?? driverRoutes[0]?.name ?? "No active route";
  const totalStops = driverRoutes.reduce((t, r) => t + (r._count?.stops ?? 0), 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={`${name} · ${activeRouteName}`}
        leading={<NavBackButton label="Fleet" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/drivers/${driverId}/edit`)}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <LinearGradient
            colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.avatar}
          >
            <Text style={styles.avatarText}>{initials}</Text>
          </LinearGradient>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.sub}>
            {driver.vehicleMake
              ? `${driver.vehicleMake} ${driver.vehicleModel ?? ""} · ${driver.vehiclePlate ?? ""}`
              : driver.status}
          </Text>
        </View>

        <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
          <InlineStats
            stats={[
              { value: String(driverRoutes.length), label: "Routes" },
              { value: String(totalStops), label: "Stops" },
              { value: driver.status, label: "Status" },
            ]}
          />
        </View>

        <SectionRow title="Assigned routes" />
        <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 20 }}>
          {driverRoutes.length === 0 ? (
            <Text style={styles.empty}>No routes assigned.</Text>
          ) : (
            driverRoutes.map((r) => {
              const stopCount = r._count?.stops ?? 0;
              const runStatus = r.runs?.[0]?.status;
              return (
                <View key={r.id} style={styles.routeCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.routeName}>{r.name}</Text>
                    <Text style={styles.routeSub}>
                      {stopCount} stop{stopCount === 1 ? "" : "s"}
                      {runStatus
                        ? ` · ${runStatus.toLowerCase().replace("_", " ")}`
                        : ""}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionRow({ title }: { title: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
  },
  header: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 18,
    alignItems: "center",
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 22, fontFamily: "Inter_700Bold" },
  name: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 10,
    letterSpacing: -0.4,
  },
  sub: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  routeCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  routeName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  routeSub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  empty: {
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
});
