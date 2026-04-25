import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { ios } from "@routeflow/ui/tokens";
import { IosEmptyState } from "@routeflow/ui/mobile/ios";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../../lib/auth-store";
import { useRoutesLive } from "../../lib/api/routes";
import { AppMapView, type MapPin, type MapPolyline } from "../../components/MapView";

export default function DriverMapScreen() {
  const user = useAuthStore((s) => s.user);
  const { data: liveData, isLoading } = useRoutesLive();
  const [foregroundLoc, setForegroundLoc] = useState<{ lat: number; lng: number } | null>(null);

  // Read the device's current GPS while this screen is visible so the driver
  // pin appears immediately, without waiting for the background tracker's
  // 30s/50m post to populate `latestLocation` server-side.
  useEffect(() => {
    if (Platform.OS === "web") return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted" || cancelled) return;
      try {
        const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!cancelled) {
          setForegroundLoc({ lat: cur.coords.latitude, lng: cur.coords.longitude });
        }
      } catch {
        // ignore — server-side latestLocation may still populate the pin
      }
      if (cancelled) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 25 },
        (pos) => setForegroundLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      );
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, []);

  const myRoute = useMemo(() => {
    if (!user?.id || !liveData?.routes) return null;
    return liveData.routes.find((r) => r.driverId === user.id) ?? null;
  }, [liveData, user?.id]);

  const { pins, polylines } = useMemo<{ pins: MapPin[]; polylines: MapPolyline[] }>(() => {
    if (!myRoute) return { pins: [], polylines: [] };

    const pinList: MapPin[] = [];

    // Prefer server-side latestLocation (authoritative, includes other devices)
    // and fall back to the live foreground reading from this screen.
    const driverLoc = myRoute.latestLocation ?? foregroundLoc;
    if (driverLoc) {
      pinList.push({
        id: "driver-me",
        lat: driverLoc.lat,
        lng: driverLoc.lng,
        title: "My location",
        color: "brand",
      });
    }

    for (const s of myRoute.stops) {
      if (s.lat == null || s.lng == null) continue;
      const isDone = s.status === "COMPLETED";
      const isCurrent =
        myRoute.stops.findIndex((x) => x.status === "PENDING" || x.status === "IN_PROGRESS") ===
        myRoute.stops.indexOf(s);
      pinList.push({
        id: `stop-${s.id}`,
        lat: s.lat,
        lng: s.lng,
        title: s.customerName,
        subtitle: `Stop ${s.stopNumber}`,
        color: isDone ? "gray" : isCurrent ? "orange" : "green",
      });
    }

    const routeCoords = myRoute.stops
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ lat: s.lat as number, lng: s.lng as number }));

    const lines: MapPolyline[] =
      routeCoords.length > 1
        ? [{ id: "route", coordinates: routeCoords, color: ios.brand, width: 3 }]
        : [];

    return { pins: pinList, polylines: lines };
  }, [myRoute, foregroundLoc]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!myRoute) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <IosEmptyState
          icon={<Ionicons name="map-outline" size={44} color={ios.brand} />}
          title="No active route"
          subtitle="Your current route stops will appear here once your run is in progress."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <AppMapView pins={pins} polylines={polylines} fitToPins style={styles.map} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  map: { flex: 1 },
});
