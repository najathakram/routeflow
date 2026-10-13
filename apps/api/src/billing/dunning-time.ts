import { DUNNING_FALLBACK_ZONE, HOUR_MS, PAUSE_LOCAL_HOUR } from "./dunning-config";

/**
 * The wall-clock hour (0-23) of `at` in `timeZone`. An unknown zone falls back to UTC rather than
 * throwing: a cron tick must never die on one tenant's bad zone string.
 */
export function localHourOf(at: Date, timeZone: string | null | undefined): number {
  const zone = timeZone || DUNNING_FALLBACK_ZONE;
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .find((p) => p.type === "hour");
    const hour = Number(part?.value);
    return Number.isFinite(hour) ? hour % 24 : at.getUTCHours();
  } catch {
    return at.getUTCHours();
  }
}

/**
 * True when the sweep at `now` may pause: the tenant-local hour is at or after {@link PAUSE_LOCAL_HOUR}.
 * The hourly sweep therefore pauses on the first run of a local day that reaches 03:00, never at 02:59.
 */
export function pauseHourReached(now: Date, timeZone: string | null | undefined): boolean {
  return localHourOf(now, timeZone) >= PAUSE_LOCAL_HOUR;
}

/** Whole hours elapsed from `since` to `now` (fractions kept; negative clamps to 0). */
export function hoursSince(since: Date, now: Date): number {
  return Math.max(0, (now.getTime() - since.getTime()) / HOUR_MS);
}
