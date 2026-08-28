"use client";

import * as React from "react";
import { useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { useGoogleMapsKey } from "@/hooks/useGoogleMapsKey";

/**
 * Draws the actual DRIVING route through an ordered list of waypoints instead
 * of straight lines between them.
 *
 * The road shape comes from the Routes API (computeRoutes) called directly
 * from the browser with the same key the Maps JS API uses — the key is
 * already browser-exposed by design (served by /public/places/config) and
 * carries "Routes API" in its API restrictions. Waypoint ORDER is preserved
 * (stop order was already decided by route optimization); TRAFFIC_UNAWARE
 * keeps every call in the cheapest billing tier.
 *
 * A straight geodesic polyline renders immediately and stays as the fallback
 * whenever the road path is unavailable (API disabled, quota, offline) — the
 * map must never lose its path because routing failed.
 */

type LatLng = { lat: number; lng: number };

// Routes API allows at most 25 intermediate waypoints per request; longer
// stop lists are chunked into consecutive requests sharing boundary points.
const MAX_INTERMEDIATES = 25;

// Module-level cache: waypoint-hash → decoded road path, or null for a known
// failure. Both directions matter — a Map re-render must not re-bill a
// request we already made this session (including one that failed).
const roadPathCache = new Map<string, LatLng[] | null>();

function cacheKeyFor(waypoints: LatLng[]): string {
  // 5 decimals ≈ 1m — identical stops produce identical requests.
  return waypoints.map((w) => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`).join("|");
}

function toRouteWaypoint(w: LatLng) {
  return { location: { latLng: { latitude: w.lat, longitude: w.lng } } };
}

async function fetchRoadPath(
  waypoints: LatLng[],
  apiKey: string,
  geometry: google.maps.GeometryLibrary,
  signal: AbortSignal,
): Promise<LatLng[]> {
  const path: LatLng[] = [];
  let start = 0;
  while (start < waypoints.length - 1) {
    const end = Math.min(start + MAX_INTERMEDIATES + 1, waypoints.length - 1);
    const chunk = waypoints.slice(start, end + 1);

    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: toRouteWaypoint(chunk[0]),
        destination: toRouteWaypoint(chunk[chunk.length - 1]),
        intermediates: chunk.slice(1, -1).map(toRouteWaypoint),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
        polylineEncoding: "ENCODED_POLYLINE",
      }),
    });
    if (!res.ok) throw new Error(`Routes API ${res.status}`);

    const data = (await res.json()) as {
      routes?: Array<{ polyline?: { encodedPolyline?: string } }>;
    };
    const encoded = data.routes?.[0]?.polyline?.encodedPolyline;
    if (!encoded) throw new Error("Routes API returned no polyline");

    const decoded = geometry.encoding
      .decodePath(encoded)
      .map((p) => ({ lat: p.lat(), lng: p.lng() }));
    // Consecutive chunks share a boundary waypoint — drop the duplicate seam.
    path.push(...(path.length ? decoded.slice(1) : decoded));
    start = end;
  }
  return path;
}

export function DrivingPathLayer({
  waypoints,
  strokeColor = "#3b82f6",
  strokeOpacity = 0.7,
  strokeWeight = 3,
  precomputedPolyline,
}: {
  waypoints: LatLng[];
  strokeColor?: string;
  strokeOpacity?: number;
  strokeWeight?: number;
  /** Encoded road polyline already computed server-side (e.g. `Route.plannedPolyline`
   *  or a chosen variant's `encodedPolyline`). When set, decode and render it
   *  directly and skip the Routes API fetch entirely — a stored route never
   *  re-bills Google per view. The straight-line fallback still applies if
   *  decoding fails. */
  precomputedPolyline?: string | null;
}) {
  const map = useMap();
  const mapsLib = useMapsLibrary("maps");
  const geometryLib = useMapsLibrary("geometry");
  const { key: apiKey } = useGoogleMapsKey();

  // Drop consecutive duplicate coordinates (two stops at the same address) —
  // Routes API rejects zero-length legs.
  const cleaned = React.useMemo(() => {
    const out: LatLng[] = [];
    for (const w of waypoints) {
      const prev = out[out.length - 1];
      if (!prev || Math.abs(prev.lat - w.lat) > 1e-7 || Math.abs(prev.lng - w.lng) > 1e-7) {
        out.push(w);
      }
    }
    return out;
  }, [waypoints]);

  const pathKey = React.useMemo(() => cacheKeyFor(cleaned), [cleaned]);
  const [road, setRoad] = React.useState<{ key: string; path: LatLng[] } | null>(null);

  // A precomputed polyline (server-solved route, or a chosen variant) is
  // decoded locally instead of calling the Routes API. Decode failure falls
  // through to the straight-line fallback below — it does NOT trigger a fetch.
  React.useEffect(() => {
    if (!geometryLib || !precomputedPolyline) return;
    try {
      const decoded = geometryLib.encoding
        .decodePath(precomputedPolyline)
        .map((p) => ({ lat: p.lat(), lng: p.lng() }));
      if (decoded.length >= 2) setRoad({ key: pathKey, path: decoded });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("Precomputed polyline decode failed, keeping straight line:", err);
    }
  }, [geometryLib, precomputedPolyline, pathKey]);

  // Fetch the road path (debounced — CreateRouteMap re-renders per stop
  // toggle and each distinct waypoint set should cost at most one request).
  // Skipped entirely when a precomputed polyline was supplied.
  React.useEffect(() => {
    if (precomputedPolyline || !geometryLib || !apiKey || cleaned.length < 2) return;

    const cached = roadPathCache.get(pathKey);
    if (cached !== undefined) {
      if (cached) setRoad({ key: pathKey, path: cached });
      return; // null = known failure this session → keep the straight line
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchRoadPath(cleaned, apiKey, geometryLib, controller.signal)
        .then((p) => {
          roadPathCache.set(pathKey, p);
          if (!controller.signal.aborted) setRoad({ key: pathKey, path: p });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          roadPathCache.set(pathKey, null);
          // eslint-disable-next-line no-console
          console.warn("Driving path unavailable, keeping straight line:", err);
        });
    }, 400);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [geometryLib, apiKey, pathKey, cleaned, precomputedPolyline]);

  const isRoad = road?.key === pathKey;
  const renderPath = isRoad ? road!.path : cleaned;

  React.useEffect(() => {
    if (!map || !mapsLib || renderPath.length < 2) return;

    const polyline = new mapsLib.Polyline({
      path: renderPath,
      geodesic: !isRoad,
      strokeColor,
      strokeOpacity,
      strokeWeight,
      map,
    });

    return () => polyline.setMap(null);
  }, [map, mapsLib, renderPath, isRoad, strokeColor, strokeOpacity, strokeWeight]);

  return null;
}
