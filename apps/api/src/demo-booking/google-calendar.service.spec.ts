import { GoogleCalendarService } from "./google-calendar.service";
import { DemoBookingConfig, loadDemoBookingConfig } from "./demo-booking.config";

/**
 * `GoogleCalendarService` with `fetch` and the delegated-token exchange
 * mocked, so these run without real Google credentials or a network call.
 */

const CONFIGURED: DemoBookingConfig = {
  ...loadDemoBookingConfig({} as NodeJS.ProcessEnv),
  saEmail: "sa@routeflow-506615.iam.gserviceaccount.com",
  saPrivateKey: "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----",
  impersonate: "admin@routeflow.info",
  calendarId: "primary",
};

class Subject extends GoogleCalendarService {
  constructor(private readonly cfg: DemoBookingConfig) {
    super();
  }
  protected config(): DemoBookingConfig {
    return this.cfg;
  }
}

function mockAccessToken() {
  // google-auth-library's JWT#getAccessToken hits its own token endpoint;
  // stub the whole client method rather than fetch's second call.
  jest
    .spyOn(require("google-auth-library").JWT.prototype, "getAccessToken")
    .mockResolvedValue({ token: "delegated-token" });
}

describe("GoogleCalendarService.getBusy — review finding 3 (fail closed, never throw)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockAccessToken();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns busy blocks on a normal 200", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          calendars: {
            primary: { busy: [{ start: "2026-10-16T14:00:00Z", end: "2026-10-16T14:30:00Z" }] },
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await new Subject(CONFIGURED).getBusy(new Date(), new Date());
    expect(result).toEqual([
      { start: new Date("2026-10-16T14:00:00Z"), end: new Date("2026-10-16T14:30:00Z") },
    ]);
  });

  it("returns null — not a throw — on a 401 (revoked delegation / bad key)", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }), { status: 401 }),
      ) as unknown as typeof fetch;

    await expect(new Subject(CONFIGURED).getBusy(new Date(), new Date())).resolves.toBeNull();
  });

  it("returns null — not a throw — on a transient 503", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 }),
      ) as unknown as typeof fetch;

    await expect(new Subject(CONFIGURED).getBusy(new Date(), new Date())).resolves.toBeNull();
  });

  it("returns null — not a throw — when fetch itself rejects (DNS/network failure)", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    await expect(new Subject(CONFIGURED).getBusy(new Date(), new Date())).resolves.toBeNull();
  });

  it("returns null when Google reports a per-calendar error inside a 200", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ calendars: { primary: { errors: [{ reason: "notFound" }] } } }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch;

    await expect(new Subject(CONFIGURED).getBusy(new Date(), new Date())).resolves.toBeNull();
  });

  it("returns null without any network call when unconfigured", async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const unconfigured = { ...CONFIGURED, saEmail: "" };

    await expect(new Subject(unconfigured).getBusy(new Date(), new Date())).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("GoogleCalendarService.createEvent — review finding 6 (no open invite relay)", () => {
  beforeEach(() => {
    mockAccessToken();
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "evt-1" }), { status: 200 }),
      ) as unknown as typeof fetch;
  });
  afterEach(() => jest.restoreAllMocks());

  it("never lets the invited (unverified) attendee invite further guests", async () => {
    await new Subject(CONFIGURED).createEvent({
      summary: "RouteFlow demo",
      description: "",
      startsAt: new Date(),
      endsAt: new Date(),
      timeZone: "America/Chicago",
      attendeeEmail: "prospect@example.com",
      attendeeName: "Prospect",
    });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.guestsCanInviteOthers).toBe(false);
  });
});
