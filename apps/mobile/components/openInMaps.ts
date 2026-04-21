import { Linking, Platform } from "react-native";

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
