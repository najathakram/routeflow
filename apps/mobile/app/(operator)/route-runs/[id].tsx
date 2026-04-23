import { useCallback, useMemo } from "react";
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
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  AppMapView,
  statusToPinColor,
  type MapPin,
  type StopStatus,
} from "../../../components/MapView";
import {
  useOptimizeRouteRun,
  useReopenStop,
  useRouteRun,
  useRouteSettings,
} from "../../../lib/api/routes";
import { showToast } from "../../../lib/toast";

function statusPill(status: string) {
  switch (status) {
    case "COMPLETED":
      return <Pill variant="green">Completed</Pill>;
    case "IN_PROGRESS":
      return <Pill variant="orange">In progress</Pill>;
    case "CANCELLED":
      return <Pill variant="gray">Cancelled</Pill>;
    default:
      return <Pill variant="brand">Scheduled</Pill>;
  }
}

export default function OperatorRouteRunScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: run, isLoading, refetch } = useRouteRun(id);
  const { data: settings } = useRouteSettings();
  const optimizeMut = useOptimizeRouteRun();
  const reopenMut = useReopenStop();

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const stops = useMemo(
    () => (run?.stops ?? []).slice().sort((a, b) => a.stopNumber - b.stopNumber),
    [run?.stops],
  );

  const { pins, missingCount } = useMemo(() => {
    const plottable: MapPin[] = [];
    let missing = 0;
    for (const s of stops) {
      const lat = s.customerAddress?.lat;
      const lng = s.customerAddress?.lng;
      if (typeof lat !== "number" || typeof lng !== "number") {
        missing += 1;
        continue;
      }
      plottable.push({
        id: s.id,
        lat,
        lng,
        title: `${s.stopNumber}. ${s.customer?.businessName ?? "Stop"}`,
        color: statusToPinColor(s.status as StopStatus),
      });
    }
    return { pins: plottable, missingCount: missing };
  }, [stops]);

  const depotPin: MapPin | null = useMemo(() => {
    if (
      settings &&
      typeof settings.depotLat === "number" &&
      typeof settings.depotLng === "number"
    ) {
      return {
        id: "depot",
        lat: settings.depotLat,
        lng: settings.depotLng,
        title: "Depot",
        subtitle: settings.depotAddress || undefined,
        color: "green",
      };
    }
    return null;
  }, [settings]);

  const allPins = depotPin ? [depotPin, ...pins] : pins;

  const handleOptimize = () => {
    if (!id) return;
    if (stops.length < 2) {
      Alert.alert("Nothing to optimize", "Need at least two stops.");
      return;
    }
    optimizeMut.mutate(id, {
      onSuccess: (res) => {
        showToast(res?.usedFallback ? "Reordered (fallback)" : "Run optimized");
        refetch();
      },
      onError: (e: any) =>
        Alert.alert(
          "Couldn't optimize",
          e?.response?.data?.message ?? e?.message ?? "Try again.",
        ),
    });
  };

  const handleReopen = (stopId: string) => {
    if (!id) return;
    Alert.alert("Reopen stop?", "The stop status will reset to pending.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reopen",
        onPress: () =>
          reopenMut.mutate(
            { runId: id, stopId },
            {
              onSuccess: () => {
                showToast("Stop reopened");
                refetch();
              },
              onError: (e: any) =>
                Alert.alert(
                  "Couldn't reopen",
                  e?.response?.data?.message ?? e?.message ?? "Try again.",
                ),
            },
          ),
      },
    ]);
  };

  if (isLoading || !run) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Route run" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const completed = stops.filter((s) => s.status === "COMPLETED").length;
  const canOptimize = run.status === "SCHEDULED";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={run.route?.name ?? "Route run"}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      {allPins.length > 0 ? (
        <View style={styles.mapWrap}>
          {missingCount > 0 ? (
            <View style={styles.banner}>
              <Ionicons name="alert-circle-outline" size={13} color={ios.system.orangeInk} />
              <Text style={styles.bannerText}>
                {missingCount} stop{missingCount === 1 ? "" : "s"} not shown — missing geocoded address
              </Text>
            </View>
          ) : null}
          <AppMapView
            pins={allPins}
            polylines={
              pins.length >= 2
                ? [
                    {
                      id: "route",
                      coordinates: pins.map((p) => ({ lat: p.lat, lng: p.lng })),
                      color: ios.brand,
                      width: 4,
                    },
                  ]
                : []
            }
            fitToPins
          />
        </View>
      ) : (
        <View style={styles.mapEmpty}>
          <Ionicons name="location-outline" size={22} color={ios.label3} />
          <Text style={styles.empty}>No geocoded stops to show on the map.</Text>
        </View>
      )}

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 12 }}>
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={styles.title}>{run.route?.name ?? "Route"}</Text>
              {statusPill(run.status)}
            </View>
            <Text style={styles.sub}>
              {run.driver?.contactName ?? "Unassigned"} · {completed}/{stops.length} stops
            </Text>
          </View>

          <Pressable
            style={styles.actionBtn}
            onPress={() => router.push(`/(operator)/route-runs/${id}/packing-list` as any)}
          >
            <Ionicons name="list-outline" size={18} color={ios.brand} />
            <Text style={styles.actionText}>Packing list</Text>
          </Pressable>

          {canOptimize ? (
            <Pressable
              style={[styles.actionBtn, optimizeMut.isPending && { opacity: 0.6 }]}
              onPress={handleOptimize}
              disabled={optimizeMut.isPending}
            >
              {optimizeMut.isPending ? (
                <ActivityIndicator color={ios.brand} size="small" />
              ) : (
                <Ionicons name="sparkles-outline" size={18} color={ios.brand} />
              )}
              <Text style={styles.actionText}>
                {optimizeMut.isPending ? "Optimizing…" : "Optimize run"}
              </Text>
            </Pressable>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Stops</Text>
            {stops.length === 0 ? (
              <Text style={styles.empty}>No stops on this run.</Text>
            ) : (
              stops.map((s, i) => {
                const noLoc =
                  typeof s.customerAddress?.lat !== "number" ||
                  typeof s.customerAddress?.lng !== "number";
                return (
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
                    <View
                      style={[
                        styles.stopBadge,
                        s.status === "COMPLETED" && { backgroundColor: "rgba(52,199,89,0.18)" },
                        s.status === "IN_PROGRESS" && { backgroundColor: "rgba(255,149,0,0.18)" },
                        s.status === "SKIPPED" && { backgroundColor: ios.fill3 },
                      ]}
                    >
                      <Text
                        style={[
                          styles.stopBadgeText,
                          s.status === "COMPLETED" && { color: ios.system.green },
                          s.status === "IN_PROGRESS" && { color: ios.system.orangeInk },
                          s.status === "SKIPPED" && { color: ios.label2 },
                        ]}
                      >
                        {s.stopNumber}
                      </Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.stopName} numberOfLines={1}>
                        {s.customer?.businessName ?? s.customerId}
                      </Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                        <Text style={styles.stopStatus}>{s.status.replace("_", " ").toLowerCase()}</Text>
                        {noLoc ? (
                          <>
                            <Text style={styles.stopStatus}>·</Text>
                            <Text style={[styles.stopStatus, { color: ios.system.orangeInk }]}>
                              no location
                            </Text>
                          </>
                        ) : null}
                      </View>
                    </View>
                    {s.status === "COMPLETED" ? (
                      <Pressable style={styles.reopenBtn} onPress={() => handleReopen(s.id)}>
                        <Ionicons name="refresh" size={14} color={ios.brand} />
                      </Pressable>
                    ) : null}
                  </View>
                );
              })
            )}
          </View>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  mapWrap: { height: 260 },
  mapEmpty: {
    height: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.fill3,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: ios.system.orangeWash,
  },
  bannerText: { fontSize: 11, fontFamily: "Inter_500Medium", color: ios.system.orangeInk, flex: 1 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 8 },
  title: { fontSize: 20, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  sub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brandWash,
    paddingVertical: 14,
    borderRadius: 12,
  },
  actionText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },
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
  stopStatus: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  reopenBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.brandWash,
    borderRadius: 8,
  },
});
