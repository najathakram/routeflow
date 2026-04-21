import { Linking, Platform } from "react-native";
import type { RouteRunStop } from "../lib/api/routes";

export interface MapTarget {
  address?: string;
  lat?: number | null;
  lng?: number | null;
  label?: string;
}

/**
 * Opens the native maps app (Apple Maps on iOS, Google Maps elsewhere) for
 * the given target. Prefers lat/lng if present, falls back to a textual
 * address search.
 */
export async function openInMaps(target: MapTarget): Promise<void> {
  const { address, lat, lng, label } = target;
  const hasCoords = typeof lat === "number" && typeof lng === "number";
  let url: string;

  if (Platform.OS === "ios") {
    if (hasCoords) {
      const q = encodeURIComponent(label ?? "Destination");
      url = `http://maps.apple.com/?ll=${lat},${lng}&q=${q}`;
    } else {
      url = `http://maps.apple.com/?q=${encodeURIComponent(address ?? "")}`;
    }
  } else {
    if (hasCoords) {
      url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    } else {
      url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address ?? "")}`;
    }
  }

  try {
    await Linking.openURL(url);
  } catch {
    // Swallow — the caller can surface a toast if desired.
  }
}

function stopToWaypoint(stop: RouteRunStop): string | null {
  const a = stop.customerAddress;
  if (!a) return null;
  if (typeof a.lat === "number" && typeof a.lng === "number") {
    return `${a.lat},${a.lng}`;
  }
  const parts = [a.line1, a.city, a.state, a.zip].filter(Boolean).join(", ");
  return parts ? encodeURIComponent(parts) : null;
}

/**
 * Opens Google Maps (always) with the full route as turn-by-turn directions.
 * Uses depot coordinates as origin when provided, otherwise falls back to the
 * first stop. Remaining stops become waypoints; the last stop is the destination.
 *
 * On iOS this still opens Google Maps via the universal URL (iOS will ask the
 * user which app to use if Google Maps is installed).
 */
export function openRouteInMaps(
  stops: RouteRunStop[],
  depotLat?: number | null,
  depotLng?: number | null,
): void {
  const sorted = [...stops].sort((a, b) => a.stopNumber - b.stopNumber);
  const waypoints = sorted.map(stopToWaypoint).filter(Boolean) as string[];

  if (waypoints.length === 0) return;

  const origin =
    typeof depotLat === "number" && typeof depotLng === "number"
      ? `${depotLat},${depotLng}`
      : waypoints[0]!;

  const destination = waypoints[waypoints.length - 1]!;
  const middle = waypoints.slice(
    typeof depotLat === "number" ? 0 : 1,
    -1,
  );

  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (middle.length > 0) {
    url += `&waypoints=${middle.join("|")}`;
  }

  Linking.openURL(url).catch(() => {});
}
