/**
 * "Open in Google Maps" export — pure client-side URL building, no server
 * involvement, no API key. Google's `computeAlternativeRoutes` doesn't work
 * with intermediate waypoints, and the Maps mobile app deep link caps out at
 * 9 waypoints per directions URL, so a long stop list is chunked into
 * sequential legs: each leg's destination becomes the next leg's origin, so a
 * driver can tap through them back-to-back without losing their place.
 *
 * Google Maps recomputes roads on-device from these coordinates — stop ORDER
 * is preserved, exact roads may differ from what RouteFlow planned. That is
 * accepted and surfaced in UI copy ("Google Maps re-checks roads live").
 */

export interface GmapsPoint {
  lat: number;
  lng: number;
}

export interface GmapsLeg {
  label: string;
  url: string;
}

// Google Maps mobile app directions deep link accepts at most 9 waypoints
// between origin and destination.
const MAX_WAYPOINTS_PER_LINK = 9;

/** Sequential Google Maps directions links covering origin → stops… → end. */
export function buildGoogleMapsLegs(points: GmapsPoint[]): GmapsLeg[] {
  if (points.length < 2) return [];

  const fmt = (p: GmapsPoint) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const legs: GmapsLeg[] = [];

  // Each link: origin + up to 9 waypoints + destination; the next link
  // re-starts at the previous destination so the driver hands off seamlessly.
  let i = 0;
  let leg = 1;
  while (i < points.length - 1) {
    const end = Math.min(i + MAX_WAYPOINTS_PER_LINK + 1, points.length - 1);
    const slice = points.slice(i, end + 1);
    const params = new URLSearchParams({
      api: "1",
      travelmode: "driving",
      origin: fmt(slice[0]),
      destination: fmt(slice[slice.length - 1]),
    });
    if (slice.length > 2) {
      params.set("waypoints", slice.slice(1, -1).map(fmt).join("|"));
    }
    legs.push({
      label: `Leg ${leg}`,
      url: `https://www.google.com/maps/dir/?${params.toString()}`,
    });
    i = end;
    leg++;
  }

  if (legs.length === 1) legs[0].label = "Open in Google Maps";
  return legs;
}
