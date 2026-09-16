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
  /** IANA zone shown on the event, so the invite reads in the guest's zone. */
  timeZone: string;
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

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private client: JWT | null = null;
  private clientKey = "";

  /** Overridable in tests; production reads `process.env` on every call. */
  protected config(): DemoBookingConfig {
    return loadDemoBookingConfig();
  }

  isConfigured(): boolean {
    return isCalendarConfigured(this.config());
  }

  /**
   * Busy blocks on the booking calendar between two instants.
   *
   * An unconfigured or unreachable calendar returns `null` — NOT an empty
   * array — so a caller can tell "nothing is booked" apart from "we have no
   * idea", and never publishes availability it cannot stand behind.
   */
  async getBusy(from: Date, to: Date): Promise<BusyBlock[] | null> {
    const config = this.config();
    if (!isCalendarConfigured(config)) return null;

    const body = await this.request<{
      calendars?: Record<
        string,
        { busy?: Array<{ start: string; end: string }>; errors?: unknown }
      >;
    }>(config, "POST", "/freeBusy", {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: config.calendarId }],
    });

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
      `/calendars/${encodeURIComponent(config.calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
      { ...this.eventBody(input), ...conference },
    );
    return this.toResult(body);
  }

  async updateEvent(eventId: string, input: CalendarEventInput): Promise<CalendarEventResult> {
    const config = this.config();
    const body = await this.request<GoogleEvent>(
      config,
      "PATCH",
      `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=all`,
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
        `/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      );
    } catch (error) {
      if (error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410)) {
        return;
      }
      throw error;
    }
  }

  private eventBody(input: CalendarEventInput) {
    return {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startsAt.toISOString(), timeZone: input.timeZone },
      end: { dateTime: input.endsAt.toISOString(), timeZone: input.timeZone },
      attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName }],
      guestsCanModify: false,
      guestsCanInviteOthers: true,
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
