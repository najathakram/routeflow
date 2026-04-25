import * as React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";

// Extracts a short stop-number prefix from titles like "2. Harbor Cafe" → "2"
function parseStopNumber(title?: string): string | null {
  if (!title) return null;
  const m = title.match(/^(\d+)[.\s]/);
  return m ? m[1] : null;
}

// Extracts the name part from "2. Harbor Cafe" → "Harbor Cafe"
function parseStopName(title?: string): string | null {
  if (!title) return null;
  return title.replace(/^\d+[.\s]+/, "").trim() || null;
}

export type StopStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";

export function statusToPinColor(status?: StopStatus): MapPin["color"] {
  switch (status) {
    case "COMPLETED":
      return "green";
    case "IN_PROGRESS":
      return "orange";
    case "SKIPPED":
      return "gray";
    case "PENDING":
    default:
      return "brand";
  }
}

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
      {pins.map((p) => {
        const stopNum = parseStopNumber(p.title);
        const stopName = parseStopName(p.title);
        const pinColor = colorFor(p.color);
        return (
          <Marker
            key={p.id}
            coordinate={{ latitude: p.lat, longitude: p.lng }}
            onPress={p.onPress}
            tracksViewChanges={false}
            anchor={{ x: 0.5, y: 1 }}
          >
            <View style={mapStyles.markerWrap}>
              {(stopNum || stopName) ? (
                <View style={mapStyles.labelBubble}>
                  {stopNum ? (
                    <Text style={[mapStyles.labelNum, { color: pinColor }]}>{stopNum}</Text>
                  ) : null}
                  {stopName ? (
                    <Text style={mapStyles.labelName} numberOfLines={1}>{stopName}</Text>
                  ) : null}
                </View>
              ) : null}
              <View style={[mapStyles.pin, { backgroundColor: pinColor }]} />
              <View style={[mapStyles.pinTip, { borderTopColor: pinColor }]} />
            </View>
          </Marker>
        );
      })}
    </RNMapView>
  );
}

function pinHex(color?: MapPin["color"]): string {
  switch (color) {
    case "gray":   return "#8e8e93";
    case "green":  return "#34c759";
    case "red":    return "#ff3b30";
    case "orange": return "#ff9500";
    default:       return "#0B6E6B";
  }
}

function WebFallback({ pins = [], polylines = [], initialRegion, style }: MapViewProps) {
  const center = React.useMemo(() => {
    if (pins.length > 0) {
      const lats = pins.map((p) => p.lat);
      const lngs = pins.map((p) => p.lng);
      return {
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      };
    }
    return { lat: initialRegion?.latitude ?? 0, lng: initialRegion?.longitude ?? 0 };
  }, [pins, initialRegion]);

  const src = React.useMemo(() => {
    const markersJs = pins
      .map((p) => {
        const c = pinHex(p.color);
        const stopNum = p.title?.match(/^(\d+)[.\s]/)?.[1] ?? "";
        const stopName = (p.title ?? "").replace(/^\d+[.\s]+/, "").trim();
        const label = [stopNum, stopName].filter(Boolean).join(" · ").replace(/"/g, '\\"');
        const tooltip = label
          ? `.bindTooltip("${label}",{permanent:true,direction:"top",offset:[0,-12],className:"rf-tip"})`
          : "";
        return `L.circleMarker([${p.lat},${p.lng}],{radius:8,color:"${c}",fillColor:"${c}",fillOpacity:.9,weight:2}).addTo(map)${tooltip};`;
      })
      .join("");

    const polysJs = (polylines ?? [])
      .map((pl) => {
        const coords = pl.coordinates.map((c) => `[${c.lat},${c.lng}]`).join(",");
        return `L.polyline([${coords}],{color:"${pl.color ?? "#0B6E6B"}",weight:${pl.width ?? 4}}).addTo(map);`;
      })
      .join("");

    const boundsJs =
      pins.length > 1
        ? `map.fitBounds(L.latLngBounds([${pins.map((p) => `[${p.lat},${p.lng}]`).join(",")}]).pad(.25));`
        : "";

    const zoom = pins.length === 0 ? 10 : 14;

    const html = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#map{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}.rf-tip{background:rgba(20,20,20,.72);color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:600;padding:2px 6px;white-space:nowrap;box-shadow:none;}.rf-tip::before{display:none;}</style>
</head><body><div id="map"></div><script>
var map=L.map("map",{zoomControl:true}).setView([${center.lat},${center.lng}],${zoom});
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"\u00a9 OpenStreetMap"}).addTo(map);
${markersJs}${polysJs}${boundsJs}
</script></body></html>`;

    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }, [pins, polylines, center]);

  return React.createElement("iframe", {
    src,
    title: "Map",
    style: { border: "none", flex: 1, width: "100%", height: "100%", minHeight: 300, ...style },
  });
}

const mapStyles = StyleSheet.create({
  markerWrap: { alignItems: "center" },
  labelBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "rgba(20,20,20,0.72)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    marginBottom: 4,
    maxWidth: 130,
  },
  labelNum: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
  },
  labelName: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
    flexShrink: 1,
  },
  pin: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "#fff",
  },
  pinTip: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    marginTop: -1,
  },
});

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
