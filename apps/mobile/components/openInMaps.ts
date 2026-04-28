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
 * the given target.
 *
 * Prefers a "Label, Address" search string so the maps app can match the
 * destination to a real business listing (showing the proper name, photo,
 * hours) instead of just dropping an unlabeled pin at lat/lng. Falls back
 * to coordinates only when no address is available.
 */
export async function openInMaps(target: MapTarget): Promise<void> {
  const { address, lat, lng, label } = target;
  const hasCoords = typeof lat === "number" && typeof lng === "number";
  const trimmedAddress = address?.trim();
  const trimmedLabel = label?.trim();
  // Prefer "Business Name, 123 Main St, City, State Zip" so Google/Apple
  // Maps match the actual place listing where one exists.
  const searchQuery = trimmedAddress
    ? trimmedLabel
      ? `${trimmedLabel}, ${trimmedAddress}`
      : trimmedAddress
    : trimmedLabel ?? "";
  let url: string;

  if (Platform.OS === "ios") {
    if (searchQuery) {
      url = `http://maps.apple.com/?q=${encodeURIComponent(searchQuery)}`;
    } else if (hasCoords) {
      const q = encodeURIComponent(trimmedLabel ?? "Destination");
      url = `http://maps.apple.com/?ll=${lat},${lng}&q=${q}`;
    } else {
      return;
    }
  } else {
    if (searchQuery) {
      url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchQuery)}`;
    } else if (hasCoords) {
      url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    } else {
      return;
    }
  }

  try {
    await Linking.openURL(url);
  } catch {
    // Swallow — the caller can surface a toast if desired.
  }
}

/**
 * Builds a Google-Maps-friendly waypoint for a single route stop.
 *
 * Prefers a "Business Name, Street, City, State Zip" search string so each
 * waypoint resolves to the actual customer location (and matches the Google
 * Place listing when one exists) instead of an unlabeled pin at raw lat/lng.
 * Falls back to coordinates only when the address is missing entirely.
 */
function stopToWaypoint(stop: RouteRunStop): string | null {
  const a = stop.customerAddress;
  const businessName = stop.customer?.businessName?.trim();

  if (a) {
    const addressParts = [a.line1, a.city, a.state, a.zip]
      .map((p) => p?.trim())
      .filter(Boolean);
    if (addressParts.length > 0) {
      const fullParts = businessName ? [businessName, ...addressParts] : addressParts;
      return encodeURIComponent(fullParts.join(", "));
    }
    if (typeof a.lat === "number" && typeof a.lng === "number") {
      return `${a.lat},${a.lng}`;
    }
  }
  return null;
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
