import type { DemoBookingStatus } from "@routeflow/types";

/**
 * Client for the public demo-booking API.
 *
 * Deliberately plain `fetch` rather than `lib/api-client.ts`: that axios
 * instance attaches the operator JWT and the `X-Tenant-Slug` header, and these
 * endpoints are public and tenant-less. A visitor booking a demo has neither.
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
const ROOT = `${API_BASE}/public/demo-bookings`;

export interface AvailabilitySlot {
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityDay {
  /** `YYYY-MM-DD` in the visitor's own zone. */
  date: string;
  slots: AvailabilitySlot[];
}

export interface Availability {
  timeZone: string;
  durationMinutes: number;
  days: AvailabilityDay[];
}

export interface Booking {
  id: string;
  name: string;
  email: string;
  company: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  status: DemoBookingStatus;
  meetUrl: string | null;
  durationMinutes: number;
}

export interface BookingDetails {
  name: string;
  email: string;
  company: string;
  phone?: string;
  notes?: string;
}

/** Carries the API's own message so the UI can show why a slot was refused. */
export class BookingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BookingError";
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const message =
      (body as { message?: string | string[] } | undefined)?.message ??
      "Something went wrong. Please try again.";
    throw new BookingError(response.status, Array.isArray(message) ? message[0] : message);
  }
  return body as T;
}

/** The visitor's IANA zone, with a safe fallback on exotic browsers. */
export function visitorTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  } catch {
    return "America/Chicago";
  }
}

export async function fetchAvailability(
  from: Date,
  to: Date,
  timeZone: string,
  signal?: AbortSignal,
): Promise<Availability> {
  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    timeZone,
  });
  return parse<Availability>(await fetch(`${ROOT}/availability?${query}`, { signal }));
}

export async function createBooking(
  details: BookingDetails,
  startsAt: string,
  timeZone: string,
): Promise<Booking> {
  const response = await fetch(ROOT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...details,
      startsAt,
      timeZone,
      sourcePage: typeof window === "undefined" ? undefined : window.location.pathname,
    }),
  });
  return parse<Booking>(response);
}

// The manage token travels in an `X-Booking-Token` header (GET) or the
// request body (POST) — never in the URL path. A URL-path token lands in
// access logs and in Sentry's error-tag on any 5xx (review finding 8).

export async function fetchBooking(token: string): Promise<Booking> {
  return parse<Booking>(await fetch(`${ROOT}/me`, { headers: { "X-Booking-Token": token } }));
}

export async function rescheduleBooking(token: string, startsAt: string): Promise<Booking> {
  const response = await fetch(`${ROOT}/reschedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, startsAt }),
  });
  return parse<Booking>(response);
}

export async function cancelBooking(token: string, reason?: string): Promise<Booking> {
  const response = await fetch(`${ROOT}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, reason }),
  });
  return parse<Booking>(response);
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

export function formatSlotTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatSlotLong(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

/** `YYYY-MM-DD` → "Tuesday, September 22", without re-entering UTC. */
export function formatDayHeading(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** A short zone label ("CDT") for showing which clock the times are in. */
export function timeZoneLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}
