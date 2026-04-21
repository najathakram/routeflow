import * as React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";

export interface MapPin {
  id: string;
  lat: number;
  lng: number;
  title?: string;
  subtitle?: string;
  color?: "brand" | "gray" | "green" | "red" | "orange";
  onPress?: () => void;
}

export interface MapPolyline {
  id: string;
  coordinates: { lat: number; lng: number }[];
  color?: string;
  width?: number;
}

export interface MapViewProps {
  pins?: MapPin[];
  polylines?: MapPolyline[];
  initialRegion?: {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
  };
  fitToPins?: boolean;
  showsUserLocation?: boolean;
  style?: any;
}

/**
 * Brand-themed wrapper around react-native-maps. On web (where the native
 * module isn't available) we render a neutral placeholder so screens don't
 * crash in the Expo web preview.
 */
export function AppMapView(props: MapViewProps) {
  if (Platform.OS === "web") {
    return <WebFallback {...props} />;
  }
  return <NativeImpl {...props} />;
}

function colorFor(name?: MapPin["color"]): string {
  switch (name) {
    case "gray":
      return ios.label2;
    case "green":
      return ios.system.green;
    case "red":
      return ios.system.red;
    case "orange":
      return ios.system.orange;
    case "brand":
    default:
      return ios.brand;
  }
}

function computeRegion(pins: MapPin[] | undefined) {
  if (!pins || pins.length === 0) return undefined;
  const lats = pins.map((p) => p.lat);
  const lngs = pins.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const padLat = Math.max(0.01, (maxLat - minLat) * 0.4);
  const padLng = Math.max(0.01, (maxLng - minLng) * 0.4);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.02, maxLat - minLat + padLat),
    longitudeDelta: Math.max(0.02, maxLng - minLng + padLng),
  };
}

function NativeImpl({
  pins = [],
  polylines = [],
  initialRegion,
  fitToPins,
  showsUserLocation,
  style,
}: MapViewProps) {
  // Dynamically require so web bundling doesn't try to resolve the native module.
  const RNMaps = require("react-native-maps") as typeof import("react-native-maps");
  const { default: RNMapView, Marker, Polyline, PROVIDER_DEFAULT } = RNMaps;

  const region = initialRegion ?? (fitToPins ? computeRegion(pins) : undefined);

  return (
    <RNMapView
      provider={PROVIDER_DEFAULT}
      style={[styles.map, style]}
      initialRegion={region}
      showsUserLocation={showsUserLocation}
      showsMyLocationButton={false}
      toolbarEnabled={false}
    >
      {polylines.map((pl) => (
        <Polyline
          key={pl.id}
          coordinates={pl.coordinates.map((c) => ({ latitude: c.lat, longitude: c.lng }))}
          strokeColor={pl.color ?? ios.brand}
          strokeWidth={pl.width ?? 4}
        />
      ))}
      {pins.map((p) => (
        <Marker
          key={p.id}
          coordinate={{ latitude: p.lat, longitude: p.lng }}
          title={p.title}
          description={p.subtitle}
          pinColor={colorFor(p.color)}
          onPress={p.onPress}
        />
      ))}
    </RNMapView>
  );
}

function WebFallback({ pins = [] }: MapViewProps) {
  return (
    <View style={styles.fallback}>
      <Text style={styles.fallbackTitle}>Map preview</Text>
      <Text style={styles.fallbackBody}>
        {pins.length === 0
          ? "No locations to show."
          : `${pins.length} location${pins.length === 1 ? "" : "s"} — open on a device to see the map.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.fill3,
    padding: 24,
  },
  fallbackTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  fallbackBody: {
    marginTop: 6,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
});
