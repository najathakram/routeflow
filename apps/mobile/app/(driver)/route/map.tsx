import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useActiveRouteRun, useRouteRun, type RouteRunStop } from "../../../lib/api/routes";
import { NetworkError } from "../../../components/NetworkError";

// Try to import react-native-maps; gracefully fall back if unavailable
let MapView: any = null;
let Marker: any = null;
let PROVIDER_DEFAULT: any = null;
try {
  const RNMaps = require("react-native-maps");
  MapView = RNMaps.default;
  Marker = RNMaps.Marker;
  PROVIDER_DEFAULT = RNMaps.PROVIDER_DEFAULT;
} catch {
  // react-native-maps not available — fallback UI will be used
}

// ─── Stop colour by status ────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: colors.success.DEFAULT,
  IN_PROGRESS: colors.brand[500],
  SKIPPED: "#94a3b8",
  PENDING: colors.navy.DEFAULT,
};

// ─── Address List Fallback ────────────────────────────────────────────────────

function AddressFallback({ stops }: { stops: RouteRunStop[] }) {
  return (
    <ScrollView
      style={styles.bg}
      contentContainerStyle={styles.fallbackContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.fallbackBanner}>
        <Ionicons name="map-outline" size={20} color={colors.brand[500]} />
        <Text style={styles.fallbackBannerText}>Map view — stops in order</Text>
      </View>
      {stops.map((stop) => {
        const address = stop.customerAddress
          ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}, ${stop.customerAddress.state} ${stop.customerAddress.zip}`
          : null;
        const color = STATUS_COLOR[stop.status] ?? "#94a3b8";
        return (
          <Pressable
            key={stop.id}
            style={styles.stopCard}
            onPress={() => router.push(`/(driver)/route/stop/${stop.id}` as any)}
            accessibilityRole="button"
            accessibilityLabel={`Stop ${stop.stopNumber}: ${stop.customer?.businessName ?? "Customer"}`}
          >
            <View style={[styles.stopBubble, { backgroundColor: color }]}>
              <Text style={styles.stopBubbleNum}>{stop.stopNumber}</Text>
            </View>
            <View style={styles.stopInfo}>
              <Text style={styles.stopBusiness}>
                {stop.customer?.businessName ?? "Customer"}
              </Text>
              {address ? (
                <Text style={styles.stopAddress} numberOfLines={2}>{address}</Text>
              ) : null}
            </View>
            <View style={[styles.statusDot, { backgroundColor: color }]} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ─── Map View ─────────────────────────────────────────────────────────────────

function StopsMap({ stops, runId }: { stops: RouteRunStop[]; runId: string }) {
  const stopsWithCoords = stops.filter(
    (s) => s.customerAddress?.lat != null && s.customerAddress?.lng != null,
  );

  if (!MapView || stopsWithCoords.length === 0) {
    return <AddressFallback stops={stops} />;
  }

  // Initial region centred on first stop with coords
  const firstCoord = stopsWithCoords[0].customerAddress!;
  const initialRegion = {
    latitude: firstCoord.lat!,
    longitude: firstCoord.lng!,
    latitudeDelta: 0.08,
    longitudeDelta: 0.08,
  };

  return (
    <View style={{ flex: 1 }}>
      <MapView
        style={{ flex: 1 }}
        provider={Platform.OS === "android" ? "google" : PROVIDER_DEFAULT}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton
      >
        {stopsWithCoords.map((stop) => {
          const color = STATUS_COLOR[stop.status] ?? "#94a3b8";
          return (
            <Marker
              key={stop.id}
              coordinate={{
                latitude: stop.customerAddress!.lat!,
                longitude: stop.customerAddress!.lng!,
              }}
              title={`Stop ${stop.stopNumber}: ${stop.customer?.businessName ?? ""}`}
              description={
                stop.customerAddress
                  ? `${stop.customerAddress.line1}, ${stop.customerAddress.city}`
                  : undefined
              }
              pinColor={color}
              onCalloutPress={() =>
                router.push(`/(driver)/route/stop/${stop.id}?runId=${runId}` as any)
              }
            />
          );
        })}
      </MapView>

      {/* Legend */}
      <View style={styles.legend}>
        {[
          { label: "Pending", color: colors.navy.DEFAULT },
          { label: "Active", color: colors.brand[500] },
          { label: "Done", color: colors.success.DEFAULT },
          { label: "Skipped", color: "#94a3b8" },
        ].map(({ label, color }) => (
          <View key={label} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: color }]} />
            <Text style={styles.legendText}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RouteMapScreen() {
  const params = useLocalSearchParams<{ runId?: string }>();

  const { data: activeData, isLoading: activeLoading, isError, refetch } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id ?? "";

  const { data: run, isLoading: runLoading } = useRouteRun(runId);

  const isLoading = activeLoading || (!!runId && runLoading);

  if (isLoading) {
    return (
      <>
        <Stack.Screen options={{ title: "Route Map", headerBackTitle: "Route" }} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.brand[500]} />
        </View>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <Stack.Screen options={{ title: "Route Map", headerBackTitle: "Route" }} />
        <NetworkError onRetry={() => refetch()} />
      </>
    );
  }

  const stops = run?.stops ?? activeData?.data?.[0]?.stops ?? [];

  if (stops.length === 0) {
    return (
      <>
        <Stack.Screen options={{ title: "Route Map", headerBackTitle: "Route" }} />
        <View style={styles.centered}>
          <Ionicons name="map-outline" size={56} color="#cbd5e1" />
          <Text style={styles.emptyText}>No stops on this route.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: `Map — ${stops.length} stops`,
          headerBackTitle: "Route",
        }}
      />
      <StopsMap stops={stops} runId={runId} />
    </>
  );
}

const styles = StyleSheet.create({
  bg: { backgroundColor: colors.surface.raised },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  fallbackContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 8,
  },
  fallbackBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 4,
  },
  fallbackBannerText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.brand[500],
  },
  stopCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    ...shadows.card,
  },
  stopBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stopBubbleNum: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  stopInfo: { flex: 1, gap: 2 },
  stopBusiness: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopAddress: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    flexShrink: 0,
  },
  legend: {
    position: "absolute",
    bottom: 16,
    left: 16,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: borderRadius.lg,
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexDirection: "row",
    gap: 14,
    ...shadows.card,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
});
