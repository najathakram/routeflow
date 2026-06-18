import { useCallback, useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { AppMapView, type MapPin } from "../../../../components/MapView";
import { useAdminRoute } from "../../../../lib/api/admin";
import { useRouteSettings } from "../../../../lib/api/routes";

export default function RouteMapScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: route, isLoading, refetch } = useAdminRoute(id);
  const { data: settings } = useRouteSettings();

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const stops = (route?.stops ?? []).slice().sort((a, b) => a.stopNumber - b.stopNumber);

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
        color: "brand",
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

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={route?.name ?? "Route map"}
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : allPins.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="location-outline" size={28} color={ios.label3} />
          <Text style={styles.empty}>
            None of the stops on this route have geocoded addresses yet. Add lat/lng on each
            customer to see them on the map.
          </Text>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {missingCount > 0 ? (
            <View style={styles.banner}>
              <Ionicons name="alert-circle-outline" size={14} color={ios.system.orangeInk} />
              <Text style={styles.bannerText}>
                {missingCount} stop{missingCount === 1 ? "" : "s"} not shown — missing geocoded
                address
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
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 10 },
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 20,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: ios.system.orangeWash,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,149,0,0.3)",
  },
  bannerText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.system.orangeInk,
    flex: 1,
  },
});
