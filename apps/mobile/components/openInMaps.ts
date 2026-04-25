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

export interface RouteMapOptions {
  /** Origin coordinates (e.g. driver's current GPS). When omitted, the first stop is used as origin. */
  originLat?: number | null;
  originLng?: number | null;
}

/**
 * Opens the route as multi-stop turn-by-turn directions. Uses the Google Maps
 * universal URL — on Android this launches Google Maps directly; on iOS it
 * opens Google Maps if installed, otherwise falls back to the browser /
 * Apple Maps. Google Maps handles the multi-stop view with timings and
 * distances. Pass `origin*` (driver's live GPS) so the route starts from the
 * driver's current position; otherwise the first stop is used as the origin.
 */
export function openRouteInMaps(
  stops: RouteRunStop[],
  options: RouteMapOptions = {},
): void {
  const sorted = [...stops].sort((a, b) => a.stopNumber - b.stopNumber);
  const waypoints = sorted.map(stopToWaypoint).filter(Boolean) as string[];

  if (waypoints.length === 0) return;

  const hasOrigin =
    typeof options.originLat === "number" && typeof options.originLng === "number";
  const originStr = hasOrigin
    ? `${options.originLat},${options.originLng}`
    : waypoints[0]!;

  const stopList = hasOrigin ? waypoints : waypoints.slice(1);
  if (stopList.length === 0) return;

  const destination = stopList[stopList.length - 1]!;
  const middle = stopList.slice(0, -1);

  let url = `https://www.google.com/maps/dir/?api=1&origin=${originStr}&destination=${destination}&travelmode=driving`;
  if (middle.length > 0) {
    url += `&waypoints=${middle.join("|")}`;
  }

  Linking.openURL(url).catch(() => {});
}
