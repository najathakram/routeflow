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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  useAdminDrivers,
  useAdminRoute,
} from "../../../../lib/api/admin";
import { useUpdateRoute } from "../../../../lib/api/routes";
import { showToast } from "../../../../lib/toast";

export default function AssignDriverScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: route } = useAdminRoute(id);
  const { data: driversData, isLoading } = useAdminDrivers({ status: "ACTIVE" });
  const drivers = driversData?.data ?? [];
  const mut = useUpdateRoute();

  const assign = (driverId: string | null) => {
    if (!id) return;
    mut.mutate(
      { id, driverId },
      {
        onSuccess: () => {
          showToast(driverId ? "Driver assigned" : "Driver removed");
          router.back();
        },
        onError: (e: any) =>
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Assign driver"
        leading={<NavBackButton label={route?.name ?? "Route"} onPress={() => router.back()} />}
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 6 }}>
          {isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : (
            <>
              {route?.driverId ? (
                <Pressable style={styles.row} onPress={() => assign(null)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>Unassign driver</Text>
                    <Text style={styles.sub}>Remove the current driver from this route.</Text>
                  </View>
                  <Ionicons name="close-circle-outline" size={22} color={ios.system.red} />
                </Pressable>
              ) : null}
              {drivers.length === 0 ? (
                <Text style={styles.empty}>No active drivers.</Text>
              ) : (
                drivers.map((d) => {
                  const name = d.user
                    ? `${d.user.firstName ?? ""} ${d.user.lastName ?? ""}`.trim() || d.user.username
                    : "Driver";
                  const isCurrent = d.id === route?.driverId;
                  return (
                    <Pressable
                      key={d.id}
                      style={[styles.row, isCurrent && styles.rowActive]}
                      onPress={() => assign(d.id)}
                      disabled={mut.isPending}
                    >
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>
                          {name
                            .split(" ")
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((p) => p[0]?.toUpperCase())
                            .join("")}
                        </Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.name}>{name}</Text>
                        {d.vehicleMake ? (
                          <Text style={styles.sub}>
                            {d.vehicleMake} {d.vehicleModel ?? ""}
                            {d.vehiclePlate ? ` · ${d.vehiclePlate}` : ""}
                          </Text>
                        ) : null}
                      </View>
                      {isCurrent ? (
                        <Ionicons name="checkmark-circle" size={20} color={ios.brand} />
                      ) : (
                        <Ionicons name="chevron-forward" size={16} color={ios.gray[3]} />
                      )}
                    </Pressable>
                  );
                })
              )}
            </>
          )}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, padding: 20, textAlign: "center" },
  row: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowActive: { borderWidth: 1.5, borderColor: ios.brand },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: ios.brand, fontSize: 13, fontFamily: "Inter_700Bold" },
  name: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
