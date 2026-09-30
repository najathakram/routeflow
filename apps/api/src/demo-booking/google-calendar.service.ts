import { Injectable, Logger } from "@nestjs/common";
import { JWT } from "google-auth-library";
import {
  DemoBookingConfig,
  isCalendarConfigured,
  loadDemoBookingConfig,
} from "./demo-booking.config";

/**
 * Thin Google Calendar v3 client for the marketing demo-booking flow.
 *
 * Authenticates as a service account with **domain-wide delegation**,
 * impersonating `GOOGLE_CALENDAR_IMPERSONATE` (admin@routeflow.info). There is
 * no refresh token to rotate and no consent screen to keep published — see
 * docs/runbooks/google-calendar-demo-booking-setup.md.
 *
 * Calls go straight to the REST API with `fetch` rather than through
 * `googleapis`: the repo already talks to Google Maps/Routes that way, and the
 * full `googleapis` bundle is tens of megabytes for the four endpoints used
 * here. `google-auth-library` is used only to mint the delegated access token.
 */

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export interface BusyBlock {
  start: Date;
  end: Date;
}

export interface CalendarEventInput {
  summary: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
  /** IANA zone the event's start/end are expressed in. */
  timeZone: string;
  /**
   * NOT added as a Calendar attendee (review round-2 finding D) — an
   * unverified public-form address becoming an attendee is how Google mails
   * a stranger's address an invite from admin@routeflow.info. Kept on the
   * type for when attendee invitation returns behind email verification.
   */
  attendeeEmail: string;
  attendeeName: string;
  /** Ask Google to mint a Meet link. Only honoured on create. */
  withMeet?: boolean;
}

export interface CalendarEventResult {
  id: string;
  meetUrl: string | null;
  htmlLink: string | null;
}

/** Raised for any non-2xx Calendar response, carrying Google's own reason. */
export class GoogleCalendarError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleCalendarError";
  }
}

interface GoogleEvent {
  id: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
}

function extractReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; errors?: Array<{ reason?: string }>; status?: string };
    };
    return (
      parsed.error?.errors?.[0]?.reason ??
      parsed.error?.status ??
      parsed.error?.message ??
      "unknown"
    );
  } catch {
    return body.slice(0, 120) || "unknown";
  }
}

/** How long a `freeBusy` result is reused for an identical window (review finding 9). */
const FREE_BUSY_CACHE_TTL_MS = 45_000;
/**
 * Hard cap on cache entries (review round-2 finding A). `getAvailability`'s
 * window includes `now()` at request time, so on the public availability
 * endpoint almost every request mints a distinct cache key — an unbounded Map
 * is unbounded heap growth driven entirely by anonymous traffic. Comfortably
 * above any real working set (45s TTL × 20/min throttle per IP is ~15 entries
 * per busy IP) while still being a real ceiling, not a formality.
 */
const FREE_BUSY_CACHE_MAX_ENTRIES = 500;

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private client: JWT | null = null;
  private clientKey = "";
  // Keyed on the exact (calendarId, from, to) triple. This protects the
  // common case — the same visitor's page re-rendering, a retry, or the
  // reschedule flow re-fetching availability moments after create — but does
  // NOT deduplicate two different visitors requesting overlapping-but-not-
  // identical windows (each computes its own "now"-anchored `from`). A
  // per-day bucketed cache would cover that case too; left for if the volume
  // ever justifies the extra complexity.
  private readonly freeBusyCache = new Map<string, { at: number; value: BusyBlock[] | null }>();

  /** Overridable in tests; production reads `process.env` on every call. */
  protected config(): DemoBookingConfig {
    return loadDemoBookingConfig();
  }

  /** Test-only: bypasses the cache TTL without waiting on a real clock. */
  protected cacheNow(): number {
    return Date.now();
  }

  isConfigured(): boolean {
    return isCalendarConfigured(this.config());
  }

  /**
   * Busy blocks on the booking calendar between two instants.
   *
   * An unconfigured, unreachable, or erroring calendar returns `null` — NOT an
   * empty array — so a caller can tell "nothing is booked" apart from "we have
   * no idea", and never publishes availability it cannot stand behind. That
   * includes a transport-level failure: a bad key, a revoked delegation, or a
   * transient Google 5xx must not throw through this method (both call sites
   * are on the public, unauthenticated path — an uncaught throw here becomes
   * an anonymous visitor's unhandled 500).
   */
  async getBusy(from: Date, to: Date): Promise<BusyBlock[] | null> {
    const config = this.config();
    if (!isCalendarConfigured(config)) return null;

    const cacheKey = `${config.calendarId}|${from.toISOString()}|${to.toISOString()}`;
    const cached = this.freeBusyCache.get(cacheKey);
    if (cached && this.cacheNow() - cached.at < FREE_BUSY_CACHE_TTL_MS) {
      return cached.value;
    }

    const result = await this.fetchBusy(config, from, to);
    // Cache a failure too, briefly — during a real Google outage this stops
    // every request in the TTL window from re-hitting a service that just
    // said no, not only the happy path.
    this.setCached(cacheKey, result);
    return result;
  }

  /** Prunes expired entries, then hard-caps size by evicting the oldest. */
  private setCached(cacheKey: string, value: BusyBlock[] | null): void {
    const now = this.cacheNow();
    for (const [key, entry] of this.freeBusyCache) {
      if (now - entry.at >= FREE_BUSY_CACHE_TTL_MS) this.freeBusyCache.delete(key);
    }
    this.freeBusyCache.set(cacheKey, { at: now, value });
    // Map iterates in insertion order, and entries are never re-inserted on a
    // hit, so the first key is genuinely the oldest.
    while (this.freeBusyCache.size > FREE_BUSY_CACHE_MAX_ENTRIES) {
      const oldest = this.freeBusyCache.keys().next().value;
      if (oldest === undefined) break;
      this.freeBusyCache.delete(oldest);
    }
  }

  private async fetchBusy(
    config: DemoBookingConfig,
    from: Date,
    to: Date,
  ): Promise<BusyBlock[] | null> {
    let body: {
      calendars?: Record<
        string,
        { busy?: Array<{ start: string; end: string }>; errors?: unknown }
      >;
    };
    try {
      body = await this.request(config, "POST", "/freeBusy", {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: config.calendarId }],
      });
    } catch (error) {
      // `request()` already logged the status/reason; this is the caller-facing
      // half of that same failure.
      this.logger.error(`demo-booking: freeBusy request failed — ${String(error)}`);
      return null;
    }

    const calendar = body.calendars?.[config.calendarId];
    if (calendar?.errors) {
      // A per-calendar error (notFound, forbidden) arrives inside a 200 body.
      // Treat it as "unknown", not "free" — the whole point of returning null.
      this.logger.error(
        `demo-booking: freeBusy reported an error for calendar ${config.calendarId}: ${JSON.stringify(calendar.errors)}`,
      );
      return null;
    }

    return (calendar?.busy ?? []).map((block) => ({
      start: new Date(block.start),
      end: new Date(block.end),
    }));
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    const config = this.config();
    const requestId = `rf-demo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const conference = input.withMeet
      ? {
          conferenceData: {
            createRequest: {
              requestId,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : {};
    const body = await this.request<GoogleEvent>(
      config,
      "POST",
      `/calendars/${encodeURIComponent(config.calendarId)}/events?conferenceDataVersion=1`,
      { ...this.eventBody(input), ...conference },
    );
    return this.toResult(body);
  }

  async updateEvent(eventId: string, input: CalendarEventInput): Promise<CalendarEventResult> {
    const config = this.config();
    const body = await this.request<GoogleEvent>(
      config,
      "PATCH",
      `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1`,
      this.eventBody(input),
    );
    return this.toResult(body);
  }

  /** Deleting an already-deleted event is a 404/410 and is treated as success. */
  async deleteEvent(eventId: string): Promise<void> {
    const config = this.config();
    try {
      await this.request(
        config,
        "DELETE",
        `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
    } catch (error) {
      if (error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410)) {
        return;
      }
      throw error;
    }
  }

  private eventBody(input: CalendarEventInput) {
    // No `attendees` and no `sendUpdates` on the request URL (both call sites
    // above): `attendeeEmail` is an unverified address from a public,
    // unauthenticated form — anyone can type anyone's address there. Adding it
    // as an attendee makes Google mail *that* address an invite from
    // admin@routeflow.info, bounded only by the create throttle (5/hour/IP) —
    // an open invitation-spam relay regardless of guestsCanInviteOthers.
    // RouteFlow's own confirmation email (demo-booking.service.ts) carries the
    // Meet link instead. `input.attendeeEmail`/`attendeeName` are unused here
    // on purpose — kept on the type for when attendee invitation returns,
    // once booking gains its own email-verification step (review round-2
    // finding D).
    return {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startsAt.toISOString(), timeZone: input.timeZone },
      end: { dateTime: input.endsAt.toISOString(), timeZone: input.timeZone },
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 24 * 60 },
          { method: "popup", minutes: 15 },
        ],
      },
    };
  }

  private toResult(event: GoogleEvent): CalendarEventResult {
    const videoEntry = event.conferenceData?.entryPoints?.find(
      (point) => point.entryPointType === "video",
    )?.uri;
    return {
      id: event.id,
      meetUrl: videoEntry ?? event.hangoutLink ?? null,
      htmlLink: event.htmlLink ?? null,
    };
  }

  /**
   * A delegated JWT client, cached until the credentials themselves change.
   * `google-auth-library` refreshes the underlying access token internally, so
   * this caches the client rather than the token.
   */
  private authClient(config: DemoBookingConfig): JWT {
    const key = `${config.saEmail}|${config.impersonate}|${config.saPrivateKey.length}`;
    if (this.client && this.clientKey === key) return this.client;
    this.client = new JWT({
      email: config.saEmail,
      key: config.saPrivateKey,
      scopes: SCOPES,
      subject: config.impersonate,
    });
    this.clientKey = key;
    return this.client;
  }

  private async request<T = unknown>(
    config: DemoBookingConfig,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    payload?: unknown,
  ): Promise<T> {
    const { token } = await this.authClient(config).getAccessToken();
    if (!token) {
      throw new GoogleCalendarError(401, "noToken", "Could not mint a delegated access token.");
    }

    const response = await fetch(`${CALENDAR_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const reason = extractReason(text);
      // Google's error bodies echo the calendar id but never the private key.
      this.logger.error(
        `demo-booking: calendar ${method} ${path.split("?")[0]} failed ${response.status} (${reason})`,
      );
      throw new GoogleCalendarError(
        response.status,
        reason,
        `Google Calendar ${method} failed with ${response.status}: ${reason}`,
      );
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
