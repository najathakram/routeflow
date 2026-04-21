import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { AppMapView, type MapPin } from "../../../../components/MapView";
import { useAdminRoute } from "../../../../lib/api/admin";

export default function RouteMapScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: route, isLoading } = useAdminRoute(id);

  const stops = (route?.stops ?? []).slice().sort((a, b) => a.stopNumber - b.stopNumber);

  const pins = useMemo<MapPin[]>(
    () =>
      stops
        .map((s) => {
          const lat = s.customerAddress?.lat;
          const lng = s.customerAddress?.lng;
          if (typeof lat !== "number" || typeof lng !== "number") return null;
          return {
            id: s.id,
            lat,
            lng,
            title: `${s.stopNumber}. ${s.customer?.businessName ?? "Stop"}`,
            color: "brand" as const,
          } satisfies MapPin;
        })
        .filter(Boolean) as MapPin[],
    [stops],
  );

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
      ) : pins.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>
            None of the stops on this route have geocoded addresses yet. Add lat/lng on each
            customer to see the route on the map.
          </Text>
        </View>
      ) : (
        <AppMapView
          pins={pins}
          polylines={[
            {
              id: "route",
              coordinates: pins.map((p) => ({ lat: p.lat, lng: p.lng })),
              color: ios.brand,
              width: 4,
            },
          ]}
          fitToPins
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    lineHeight: 20,
  },
});
