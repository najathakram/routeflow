/**
 * Google Maps deep-link export — mirrors `apps/web/lib/gmaps-export.ts` byte
 * for byte (minus web-only types). Pure TS, no RN imports: builds sequential
 * "Open in Google Maps" directions links covering an ordered list of stops.
 *
 * Google Maps' mobile app caps a single directions link at 9 waypoints (plus
 * origin/destination), so a longer route chunks into multiple legs — each leg
 * re-starts at the previous leg's destination so the driver hands off
 * seamlessly from one link to the next. Stop ORDER is preserved end to end;
 * Google Maps recomputes the actual roads on-device.
 */
export interface GmapsPoint {
  lat: number;
  lng: number;
}

const MAX_WAYPOINTS_PER_LINK = 9; // Google Maps mobile app limit

/** Sequential Google Maps directions links covering origin → stops… → end. */
export function buildGoogleMapsLegs(points: GmapsPoint[]): { label: string; url: string }[] {
  if (points.length < 2) return [];
  const fmt = (p: GmapsPoint) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const legs: { label: string; url: string }[] = [];
  // Each link: origin + up to 9 waypoints + destination; the next link re-starts at the
  // previous destination so the driver hands off seamlessly.
  let i = 0;
  let leg = 1;
  while (i < points.length - 1) {
    const end = Math.min(i + MAX_WAYPOINTS_PER_LINK + 1, points.length - 1);
    const slice = points.slice(i, end + 1);
    const params = new URLSearchParams({
      api: "1",
      travelmode: "driving",
      origin: fmt(slice[0]!),
      destination: fmt(slice[slice.length - 1]!),
    });
    if (slice.length > 2) params.set("waypoints", slice.slice(1, -1).map(fmt).join("|"));
    legs.push({
      label: `Leg ${leg}`,
      url: `https://www.google.com/maps/dir/?${params.toString()}`,
    });
    i = end;
    leg++;
  }
  if (legs.length === 1) legs[0]!.label = "Open in Google Maps";
  return legs;
}
