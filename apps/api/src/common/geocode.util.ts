import { Logger } from "@nestjs/common";

/** Minimal shape needed to build a geocodable query string. */
export interface GeocodableAddress {
  line1: string;
  city: string;
  state: string;
  zip: string;
}

export interface GeocodeCoords {
  lat: number;
  lng: number;
}

/**
 * Hard ceiling on the outbound geocode call. Callers await this inline before their write,
 * so an unresponsive Google must never hold the request open (undici's default headers
 * timeout is ~300s). The abort surfaces as a rejection and falls through to `null`.
 */
const GEOCODE_TIMEOUT_MS = 5000;

/**
 * Geocode an address via the Google Maps Geocoding API. Returns null when the API
 * key is missing, the address can't be resolved, or the call fails for any reason —
 * geocoding is always best-effort and must NEVER throw or block the caller's write.
 * Pass the caller's own `Logger` so a failure surfaces under that service's context.
 *
 * Shared by `CustomersService` (customer addresses) and `SuppliersService` (supplier
 * addresses) — keep both call sites pointed at this one implementation.
 */
export async function geocodeAddress(
  addr: GeocodableAddress,
  apiKey: string | undefined | null,
  logger?: Logger,
): Promise<GeocodeCoords | null> {
  const key = apiKey ?? "";
  if (!key) return null;
  const q = encodeURIComponent(`${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`);
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${key}`,
      { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
    };
    const loc = data.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch (err) {
    logger?.warn("Geocoding failed", err as Error);
    return null;
  }
}
