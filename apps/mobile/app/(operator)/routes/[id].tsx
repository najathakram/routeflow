import { useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useAdminDrivers,
  useAdminRoute,
} from "../../../lib/api/admin";
import {
  useDeleteRoute,
  useRemoveRouteStop,
  useReorderRouteStops,
} from "../../../lib/api/routes";
import { showToast } from "../../../lib/toast";

export default function RouteDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: route, isLoading, refetch } = useAdminRoute(id);
  const { data: driversData } = useAdminDrivers();
  const driver = useMemo(
    () => driversData?.data.find((d) => d.id === route?.driverId),
    [driversData, route?.driverId],
  );
  const deleteMut = useDeleteRoute();
  const removeMut = useRemoveRouteStop();
  const reorderMut = useReorderRouteStops();

  if (isLoading || !route) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Route" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const stops = (route.stops ?? []).slice().sort((a, b) => a.stopNumber - b.stopNumber);
  const driverName = driver
    ? `${driver.user?.firstName ?? ""} ${driver.user?.lastName ?? ""}`.trim() || driver.user?.username
    : null;

  const removeStop = (stopId: string) => {
    if (!id) return;
    Alert.alert("Remove stop?", "The customer will be removed from this route.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          removeMut.mutate(
            { routeId: id, stopId },
            {
              onSuccess: () => {
                showToast("Stop removed");
                refetch();
              },
              onError: (e: any) =>
                Alert.alert("Couldn't remove", e?.response?.data?.message ?? e?.message ?? "Try again."),
            },
          ),
      },
    ]);
  };

  const reorder = (idx: number, dir: -1 | 1) => {
    if (!id) return;
    const next = [...stops];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    const a = next[idx];
    const b = next[swapIdx];
    if (!a || !b) return;
    const order = next.map((s, i) => {
      if (i === idx) return { id: s.id, stopNumber: b.stopNumber };
      if (i === swapIdx) return { id: s.id, stopNumber: a.stopNumber };
      return { id: s.id, stopNumber: s.stopNumber };
    });
    reorderMut.mutate(
      { routeId: id, order },
      {
        onSuccess: () => refetch(),
        onError: (e: any) =>
          Alert.alert("Couldn't reorder", e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const handleDelete = () => {
    if (!id) return;
    Alert.alert("Delete route?", `${route.name} and all its stops will be removed.`, [
      { text: "Keep", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteMut.mutate(id, {
            onSuccess: () => {
              showToast("Route deleted");
              router.back();
            },
            onError: (e: any) =>
              Alert.alert("Couldn't delete", e?.response?.data?.message ?? e?.message ?? "Try again."),
          }),
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={route.name}
        leading={<NavBackButton label="Routes" onPress={() => router.back()} />}
        trailing={
          <NavAction label="Edit" bold onPress={() => router.push(`/(operator)/routes/${id}/edit`)} />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={styles.title}>{route.name}</Text>
              {route.isActive === false ? <Pill variant="gray">Inactive</Pill> : null}
            </View>
            {route.description ? <Text style={styles.desc}>{route.description}</Text> : null}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Driver</Text>
              <Pressable onPress={() => router.push(`/(operator)/routes/${id}/assign-driver`)}>
                <Text style={styles.linkText}>{driver ? "Change" : "Assign"}</Text>
              </Pressable>
            </View>
            <Text style={styles.driverName}>{driverName ?? "Not assigned"}</Text>
            {driver?.vehicleMake ? (
              <Text style={styles.sub}>
                {driver.vehicleMake} {driver.vehicleModel ?? ""}
                {driver.vehiclePlate ? ` · ${driver.vehiclePlate}` : ""}
              </Text>
            ) : null}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Stops ({stops.length})</Text>
              <Pressable onPress={() => router.push(`/(operator)/routes/${id}/add-stop`)}>
                <Text style={styles.linkText}>Add</Text>
              </Pressable>
            </View>
            {stops.length === 0 ? (
              <Text style={styles.empty}>No stops yet.</Text>
            ) : (
              stops.map((s, i) => (
                <View
                  key={s.id}
                  style={[
                    styles.stopRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={styles.stopBadge}>
                    <Text style={styles.stopBadgeText}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.stopName} numberOfLines={1}>
                      {s.customer?.businessName ?? s.customerId}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 4 }}>
                    <Pressable style={styles.iconBtn} onPress={() => reorder(i, -1)} disabled={i === 0}>
                      <Ionicons
                        name="arrow-up"
                        size={14}
                        color={i === 0 ? ios.label3 : ios.brand}
                      />
                    </Pressable>
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => reorder(i, 1)}
                      disabled={i === stops.length - 1}
                    >
                      <Ionicons
                        name="arrow-down"
                        size={14}
                        color={i === stops.length - 1 ? ios.label3 : ios.brand}
                      />
                    </Pressable>
                    <Pressable style={styles.iconBtn} onPress={() => removeStop(s.id)}>
                      <Ionicons name="trash-outline" size={14} color={ios.system.red} />
                    </Pressable>
                  </View>
                </View>
              ))
            )}
          </View>

          <Pressable
            style={styles.mapBtn}
            onPress={() => router.push(`/(operator)/routes/${id}/map`)}
          >
            <Ionicons name="map-outline" size={18} color={ios.brand} />
            <Text style={styles.mapBtnText}>View on map</Text>
          </Pressable>

          <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={deleteMut.isPending}>
            <Ionicons name="trash-outline" size={18} color={ios.system.red} />
            <Text style={styles.deleteBtnText}>Delete route</Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 6 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  desc: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  driverName: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 4 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 8 },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  stopBadge: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  stopBadgeText: { color: ios.brand, fontSize: 12, fontFamily: "Inter_700Bold" },
  stopName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  iconBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.fill3,
    borderRadius: 8,
  },
  mapBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brandWash,
    paddingVertical: 14,
    borderRadius: 12,
  },
  mapBtnText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.bgElev,
    paddingVertical: 14,
    borderRadius: 12,
  },
  deleteBtnText: { color: ios.system.red, fontSize: 15, fontFamily: "Inter_500Medium" },
});
