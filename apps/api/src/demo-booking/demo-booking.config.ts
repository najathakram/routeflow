/**
 * Environment-driven configuration for public demo booking.
 *
 * Every value has a working default EXCEPT the Google credentials and the
 * manage-token secret. When those are missing the feature fails closed —
 * `isCalendarConfigured()` is false, availability returns nothing, and booking
 * is refused — rather than inventing slots nobody is actually free for.
 * Setup runbook: docs/runbooks/google-calendar-demo-booking-setup.md
 */

export interface DemoBookingConfig {
  /** Service-account credentials for domain-wide delegation. */
  saEmail: string;
  saPrivateKey: string;
  /** The Workspace user whose calendar is read and written (admin@routeflow.info). */
  impersonate: string;
  calendarId: string;
  /** HMAC key for the cancel/reschedule links in the confirmation email. */
  tokenSecret: string;

  /** IANA zone the business hours below are expressed in. */
  businessTimeZone: string;
  /** Local wall-clock window bookable slots are generated inside. */
  openHour: number;
  openMinute: number;
  closeHour: number;
  closeMinute: number;
  /** Bookable weekdays, 0 = Sunday. */
  weekdays: number[];

  durationMinutes: number;
  slotIntervalMinutes: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
}

function num(raw: string | undefined, fallback: number): number {
  // Strict — a partial parse silently changing a booking window is the same
  // class of bug login-throttle.config.ts guards against.
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseClock(raw: string | undefined, fallbackH: number, fallbackM: number) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((raw ?? "").trim());
  if (!match) return { hour: fallbackH, minute: fallbackM };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseWeekdays(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^[0-6]$/.test(part))
    .map(Number);
  const unique = [...new Set(parsed)].sort((a, b) => a - b);
  return unique.length ? unique : fallback;
}

/**
 * Railway stores the service-account PEM as a single line with literal `\n`
 * two-character sequences (that is how it appears inside the downloaded JSON
 * key). Normalise those back to real newlines, and tolerate the surrounding
 * quotes some paste flows add.
 */
function normalisePrivateKey(raw: string | undefined): string {
  if (!raw) return "";
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n").trim();
}

export function loadDemoBookingConfig(env: NodeJS.ProcessEnv = process.env): DemoBookingConfig {
  const open = parseClock(env.DEMO_BOOKING_OPEN, 9, 0);
  const close = parseClock(env.DEMO_BOOKING_CLOSE, 17, 0);
  return {
    saEmail: (env.GOOGLE_CALENDAR_SA_EMAIL ?? "").trim(),
    saPrivateKey: normalisePrivateKey(env.GOOGLE_CALENDAR_SA_PRIVATE_KEY),
    impersonate: (env.GOOGLE_CALENDAR_IMPERSONATE ?? "").trim(),
    calendarId: (env.GOOGLE_CALENDAR_ID ?? "primary").trim() || "primary",
    tokenSecret: (env.DEMO_BOOKING_TOKEN_SECRET ?? "").trim(),

    businessTimeZone: (env.DEMO_BOOKING_TIMEZONE ?? "America/Chicago").trim(),
    openHour: open.hour,
    openMinute: open.minute,
    closeHour: close.hour,
    closeMinute: close.minute,
    weekdays: parseWeekdays(env.DEMO_BOOKING_WEEKDAYS, [1, 2, 3, 4, 5]),

    durationMinutes: num(env.DEMO_BOOKING_DURATION_MINUTES, 30),
    slotIntervalMinutes: num(env.DEMO_BOOKING_SLOT_INTERVAL_MINUTES, 30),
    minNoticeHours: num(env.DEMO_BOOKING_MIN_NOTICE_HOURS, 12),
    maxAdvanceDays: num(env.DEMO_BOOKING_MAX_ADVANCE_DAYS, 60),
  };
}

/** Google credentials present — availability and booking can reach the calendar. */
export function isCalendarConfigured(config: DemoBookingConfig): boolean {
  return Boolean(
    config.saEmail &&
    config.saPrivateKey.includes("BEGIN") &&
    config.impersonate &&
    config.calendarId,
  );
}

/** Manage-token secret present — cancel/reschedule links can be signed. */
export function isTokenSigningConfigured(config: DemoBookingConfig): boolean {
  return config.tokenSecret.length >= 16;
}
