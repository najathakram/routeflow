/** IANA time zones for the tenant time-zone controls (create tenant, Settings). */

export const SUGGESTED_TIME_ZONE = "America/New_York";

/** The one line both screens show for a missing or unusable zone. */
export const TIME_ZONE_REQUIRED_COPY = "Choose a time zone.";

/** Used only when the runtime lacks `Intl.supportedValuesOf` (older browsers, jsdom). */
const FALLBACK_TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.("timeZone");
    if (Array.isArray(all) && all.length > 0) return all;
  } catch {
    /* fall through to the built-in list */
  }
  return FALLBACK_TIME_ZONES;
}

/**
 * The canonical spelling of an IANA zone (`america/chicago` becomes `America/Chicago`), or null when the value
 * is not UTC or an Area/Location name the runtime knows. Offsets such as `+05:00` are refused.
 */
export function canonicalTimeZone(value: string): string | null {
  if (!value || value !== value.trim()) return null;
  if (value.toUpperCase() !== "UTC" && !value.includes("/")) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function isValidTimeZone(value: string): boolean {
  return canonicalTimeZone(value) !== null;
}
