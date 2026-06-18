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
import { useAdminDrivers, type AdminDriver } from "../../../lib/api/admin";

function nameOf(d: AdminDriver): string {
  if (d.user?.firstName || d.user?.lastName) {
    return `${d.user.firstName ?? ""} ${d.user.lastName ?? ""}`.trim();
  }
  return d.user?.username ?? "Driver";
}

export default function DriversListScreen() {
  const router = useRouter();
  const { data, isLoading, isFetching, refetch } = useAdminDrivers({ limit: 100 });
  const drivers = data?.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Drivers"
        subtitle={`${drivers.length} driver${drivers.length === 1 ? "" : "s"}`}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction label="Add" bold onPress={() => router.push("/(operator)/drivers/new")} />
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
        ) : drivers.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No drivers yet.</Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(operator)/drivers/new")}
            >
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Add driver</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {drivers.map((d) => {
              const name = nameOf(d);
              const initials =
                name
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((p) => p[0]?.toUpperCase())
                  .join("") || "?";
              return (
                <Pressable
                  key={d.id}
                  style={styles.row}
                  onPress={() => router.push(`/(operator)/driver?id=${encodeURIComponent(d.id)}`)}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initials}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name}>{name}</Text>
                    <Text style={styles.sub}>
                      {d.vehicleMake
                        ? `${d.vehicleMake} ${d.vehicleModel ?? ""}${d.vehiclePlate ? ` · ${d.vehiclePlate}` : ""}`
                        : "No vehicle"}
                    </Text>
                  </View>
                  <Pill variant={d.status === "ACTIVE" ? "green" : "gray"}>
                    {d.status.toLowerCase()}
                  </Pill>
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
  empty: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label2 },
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
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
