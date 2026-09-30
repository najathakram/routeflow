/**
 * Seam module (B185 / WP-MOB-LOC): the location POST body construction,
 * extracted out of `location-tracker.native.ts`'s two inline call sites so it
 * can be unit-tested without Expo/TaskManager. iOS reports `-1` for
 * heading/speed when it has no fix — that sentinel used to pass straight
 * through and the API's `@Min(0)` decorators 400'd the whole ping. This body
 * maps a negative-or-null heading/speed to `null`, converts a valid speed
 * from m/s to km/h, and passes `accuracy` through only when it is present and
 * non-negative (omitted otherwise, matching the API's `@Min(0)` bound). A
 * converted speed above MAX_SPEED_KPH, an accuracy above MAX_ACCURACY_M, or a
 * heading above MAX_HEADING_DEG is treated as implausible and mapped to
 * `null`/omitted (never clamped) so a glitched fix can't 400 the whole ping.
 * These four constants mirror all four of the API DTO's upper/lower bounds
 * (post-location.dto.ts): @Min(0)/@Max(500) speedKph, @Min(0)/@Max(360)
 * heading, and @Min(0)/@Max(99999.99) accuracy — a value the API would
 * reject is dropped to null/omitted here, never clamped or fabricated.
 */
const MAX_SPEED_KPH = 500;
const MAX_ACCURACY_M = 99999.99;
const MAX_HEADING_DEG = 360;

export function buildLocationPayload(
  coords: {
    latitude: number;
    longitude: number;
    heading?: number | null;
    speed?: number | null;
    accuracy?: number | null;
  },
  recordedAt: string,
): {
  heading: number | null;
  speedKph: number | null;
  accuracy?: number;
  recordedAt: string;
} {
  const rawHeading = coords.heading != null && coords.heading >= 0 ? coords.heading : null;
  const heading = rawHeading != null && rawHeading > MAX_HEADING_DEG ? null : rawHeading;
  const rawSpeedKph = coords.speed != null && coords.speed >= 0 ? coords.speed * 3.6 : null;
  const speedKph = rawSpeedKph != null && rawSpeedKph > MAX_SPEED_KPH ? null : rawSpeedKph;
  const rawAccuracy = coords.accuracy != null && coords.accuracy >= 0 ? coords.accuracy : undefined;
  const accuracy = rawAccuracy != null && rawAccuracy > MAX_ACCURACY_M ? undefined : rawAccuracy;
  return { heading, speedKph, accuracy, recordedAt };
  // lat/lng/runId are added by each call site around this return, matching
  // today's shape — this function owns ONLY the sentinel-mapping fields.
}
