import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import * as Location from "expo-location";
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
  useUpdateRunStatus,
  useUpdateStopStatus,
} from "../../../lib/api/routes";
import { openRouteInMaps } from "../../../components/openInMaps";
import { showToast } from "../../../lib/toast";

async function readCurrentLocation(): Promise<{ lat: number; lng: number } | null> {
  if (Platform.OS === "web") {
    if (typeof navigator === "undefined" || !navigator.geolocation) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 5000 },
      );
    });
  }
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") return null;
    const cur = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return { lat: cur.coords.latitude, lng: cur.coords.longitude };
  } catch {
    return null;
  }
}

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
  const updateStatusMut = useUpdateStopStatus();
  const cancelRunMut = useUpdateRunStatus();

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

  const handleOptimize = async () => {
    if (!id) return;
    if (stops.length < 2) {
      Alert.alert("Nothing to optimize", "Need at least two stops.");
      return;
    }
    const useCurrent = run?.status === "IN_PROGRESS";
    const origin = useCurrent ? await readCurrentLocation() : null;
    const input = origin
      ? { id, originLat: origin.lat, originLng: origin.lng }
      : id;
    optimizeMut.mutate(input, {
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

  const handleOpenInMaps = async () => {
    const pending = stops.filter(
      (s) => s.status === "PENDING" || s.status === "IN_PROGRESS",
    );
    if (pending.length === 0) {
      showToast("No pending stops");
      return;
    }
    const origin =
      run?.status === "IN_PROGRESS" ? await readCurrentLocation() : null;
    openRouteInMaps(pending, {
      originLat: origin?.lat,
      originLng: origin?.lng,
    });
  };

  const handleSkip = (stopId: string) => {
    if (!id) return;
    Alert.alert("Skip stop?", "It will be marked as skipped on this run.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Skip",
        style: "destructive",
        onPress: () =>
          updateStatusMut.mutate(
            { runId: id, stopId, status: "SKIPPED" },
            {
              onSuccess: () => {
                showToast("Stop skipped");
                refetch();
              },
              onError: (e: any) =>
                Alert.alert(
                  "Couldn't skip",
                  e?.response?.data?.message ?? e?.message ?? "Try again.",
                ),
            },
          ),
      },
    ]);
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

  const handleCancelRun = () => {
    if (!id) return;
    Alert.alert(
      "Cancel run?",
      "The run will be marked cancelled. Drivers can no longer check in or complete stops.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Cancel run",
          style: "destructive",
          onPress: () =>
            cancelRunMut.mutate(
              { id, status: "CANCELLED" },
              {
                onSuccess: () => {
                  showToast("Run cancelled");
                  refetch();
                },
                onError: (e: any) =>
                  Alert.alert(
                    "Couldn't cancel",
                    e?.response?.data?.message ?? e?.message ?? "Try again.",
                  ),
              },
            ),
        },
      ],
    );
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
  const skipped = stops.filter((s) => s.status === "SKIPPED").length;
  const inProgress = stops.find((s) => s.status === "IN_PROGRESS");
  const nextPending = stops.find((s) => s.status === "PENDING");
  const currentStop = inProgress ?? nextPending;
  const total = stops.length;
  const pending = total - completed - skipped;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const canOptimize =
    run.status === "SCHEDULED" || run.status === "IN_PROGRESS";
  const isTerminal =
    run.status === "COMPLETED" || run.status === "CANCELLED";

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
              {run.driver?.contactName ?? "Unassigned"} · {completed}/{total} stops
            </Text>

            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${percent}%` }]} />
            </View>

            <View style={styles.statRow}>
              <View style={styles.stat}>
                <Text style={[styles.statNum, { color: ios.system.green }]}>{completed}</Text>
                <Text style={styles.statLabel}>Done</Text>
              </View>
              <View style={styles.stat}>
                <Text style={[styles.statNum, { color: ios.brand }]}>{pending}</Text>
                <Text style={styles.statLabel}>Pending</Text>
              </View>
              <View style={styles.stat}>
                <Text style={[styles.statNum, { color: ios.label2 }]}>{skipped}</Text>
                <Text style={styles.statLabel}>Skipped</Text>
              </View>
              <View style={styles.stat}>
                <Text style={[styles.statNum, { color: ios.label }]}>{percent}%</Text>
                <Text style={styles.statLabel}>Progress</Text>
              </View>
            </View>

            {currentStop ? (
              <View style={styles.currentStop}>
                <Ionicons
                  name={inProgress ? "navigate" : "flag-outline"}
                  size={14}
                  color={ios.brand}
                />
                <Text style={styles.currentStopText} numberOfLines={1}>
                  {inProgress ? "Now: " : "Next: "}
                  {currentStop.customer?.businessName ?? "Stop"}
                  {" · #"}
                  {currentStop.stopNumber}
                </Text>
              </View>
            ) : null}
          </View>

          <Pressable
            style={styles.actionBtn}
            onPress={() => router.push(`/(operator)/route-runs/${id}/packing-list` as any)}
          >
            <Ionicons name="list-outline" size={18} color={ios.brand} />
            <Text style={styles.actionText}>Packing list</Text>
          </Pressable>

          {!isTerminal ? (
            <Pressable style={styles.actionBtn} onPress={handleOpenInMaps}>
              <Ionicons name="map-outline" size={18} color={ios.brand} />
              <Text style={styles.actionText}>Open in Google Maps</Text>
            </Pressable>
          ) : null}

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
                {optimizeMut.isPending
                  ? "Optimizing…"
                  : run.status === "IN_PROGRESS"
                  ? "Re-optimize from here"
                  : "Optimize run"}
              </Text>
            </Pressable>
          ) : null}

          {pins.length > 0 ? (
            <Pressable
              style={styles.actionBtn}
              onPress={() => openRouteInMaps(stops as any)}
            >
              <Ionicons name="navigate-outline" size={18} color={ios.brand} />
              <Text style={styles.actionText}>Open in Google Maps</Text>
            </Pressable>
          ) : null}

          {!isTerminal ? (
            <Pressable
              style={[styles.cancelBtn, cancelRunMut.isPending && { opacity: 0.6 }]}
              onPress={handleCancelRun}
              disabled={cancelRunMut.isPending}
            >
              {cancelRunMut.isPending ? (
                <ActivityIndicator color={ios.system.red} size="small" />
              ) : (
                <Ionicons name="close-circle-outline" size={18} color={ios.system.red} />
              )}
              <Text style={styles.cancelBtnText}>
                {cancelRunMut.isPending ? "Cancelling…" : "Cancel run"}
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
                    ) : s.status === "PENDING" || s.status === "IN_PROGRESS" ? (
                      <Pressable style={styles.skipBtn} onPress={() => handleSkip(s.id)}>
                        <Ionicons name="close" size={14} color={ios.label2} />
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
  skipBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.fill3,
    borderRadius: 8,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: ios.fill3,
    overflow: "hidden",
    marginTop: 4,
  },
  progressFill: {
    height: "100%",
    backgroundColor: ios.brand,
    borderRadius: 3,
  },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  stat: { alignItems: "center", flex: 1 },
  statNum: { fontSize: 18, fontFamily: "Inter_700Bold" },
  statLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    marginTop: 2,
  },
  currentStop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    marginTop: 4,
  },
  currentStopText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
  },
  cancelBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.system.redWash,
    paddingVertical: 14,
    borderRadius: 12,
  },
  cancelBtnText: {
    color: ios.system.red,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
});
