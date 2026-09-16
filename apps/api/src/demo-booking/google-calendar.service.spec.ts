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
  fakeNow = 0;
  constructor(private readonly cfg: DemoBookingConfig) {
    super();
  }
  protected config(): DemoBookingConfig {
    return this.cfg;
  }
  protected cacheNow(): number {
    return this.fakeNow;
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

describe("GoogleCalendarService.getBusy — review finding 9 (freeBusy caching)", () => {
  beforeEach(() => {
    mockAccessToken();
    // mockImplementation (not mockResolvedValue) — several of these tests
    // expect fetch to actually be called more than once, and a `Response`
    // body can only be read once, so every call needs its OWN instance.
    global.fetch = jest.fn().mockImplementation(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              calendars: {
                primary: { busy: [{ start: "2026-10-16T14:00:00Z", end: "2026-10-16T14:30:00Z" }] },
              },
            }),
            { status: 200 },
          ),
        ) as unknown as Promise<Response>,
    ) as unknown as typeof fetch;
  });
  afterEach(() => jest.restoreAllMocks());

  const from = new Date("2026-10-16T00:00:00Z");
  const to = new Date("2026-10-17T00:00:00Z");

  it("reuses a cached result for the identical window within the TTL — one network call for two requests", async () => {
    const subject = new Subject(CONFIGURED);
    subject.fakeNow = 0;

    const first = await subject.getBusy(from, to);
    const second = await subject.getBusy(from, to);

    expect(first).toEqual(second);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the TTL has elapsed", async () => {
    const subject = new Subject(CONFIGURED);
    subject.fakeNow = 0;
    await subject.getBusy(from, to);

    subject.fakeNow = 46_000; // just past the 45s TTL
    await subject.getBusy(from, to);

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not share a cache entry across a different window", async () => {
    const subject = new Subject(CONFIGURED);
    subject.fakeNow = 0;
    await subject.getBusy(from, to);
    await subject.getBusy(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-02T00:00:00Z"));

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  // Review round-2 finding A: `getAvailability`'s window includes `now()` at
  // request time, so on the public endpoint nearly every request mints a
  // distinct key — without a cap the Map grows without bound.
  it("REG-review-round2-A: caps cache size — the oldest entry is evicted once the cap is exceeded", async () => {
    const subject = new Subject(CONFIGURED);
    subject.fakeNow = 0; // fixed "now" — nothing expires by TTL during this test

    const windowAt = (dayOffset: number) => ({
      from: new Date(2026, 0, 1 + dayOffset),
      to: new Date(2026, 0, 2 + dayOffset),
    });

    // One more than the 500-entry cap — the very first window must be the one
    // evicted (insertion order = eviction order, since nothing here is a hit).
    for (let i = 0; i < 501; i += 1) {
      const { from: f, to: t } = windowAt(i);
      await subject.getBusy(f, t);
    }
    expect(global.fetch).toHaveBeenCalledTimes(501);

    // Window 0 was evicted — re-requesting it is a fresh network call.
    const evicted = windowAt(0);
    await subject.getBusy(evicted.from, evicted.to);
    expect(global.fetch).toHaveBeenCalledTimes(502);

    // Window 500 (the most recent) is still cached — no new call.
    const recent = windowAt(500);
    await subject.getBusy(recent.from, recent.to);
    expect(global.fetch).toHaveBeenCalledTimes(502);
  });

  it("also caches a failure briefly, so a Google outage does not get hit on every request", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 }),
      ) as unknown as typeof fetch;
    const subject = new Subject(CONFIGURED);
    subject.fakeNow = 0;

    await subject.getBusy(from, to);
    await subject.getBusy(from, to);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("GoogleCalendarService.createEvent — review finding 6 (no open invite relay)", () => {
  beforeEach(() => {
    mockAccessToken();
    // mockImplementation (not mockResolvedValue) — some tests below call
    // create/update/delete in the same test, and a Response body can only be
    // read once, so every call needs its own instance.
    global.fetch = jest
      .fn()
      .mockImplementation(
        () =>
          Promise.resolve(
            new Response(JSON.stringify({ id: "evt-1" }), { status: 200 }),
          ) as unknown as Promise<Response>,
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

  // Review round-2 finding D: guestsCanInviteOthers:false alone still leaves
  // Google mailing the unverified address an invite as an attendee — the
  // deeper fix is not adding it as an attendee at all.
  it("REG-review-round2-D: does not add the unverified address as an attendee, on create or update", async () => {
    const subject = new Subject(CONFIGURED);
    const input = {
      summary: "RouteFlow demo",
      description: "",
      startsAt: new Date(),
      endsAt: new Date(),
      timeZone: "America/Chicago",
      attendeeEmail: "prospect@example.com",
      attendeeName: "Prospect",
    };

    await subject.createEvent(input);
    await subject.updateEvent("evt-1", input);

    for (const call of (global.fetch as jest.Mock).mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body).not.toHaveProperty("attendees");
    }
  });

  it("REG-review-round2-D: does not request sendUpdates on create, update, or delete", async () => {
    const subject = new Subject(CONFIGURED);
    const input = {
      summary: "RouteFlow demo",
      description: "",
      startsAt: new Date(),
      endsAt: new Date(),
      timeZone: "America/Chicago",
      attendeeEmail: "prospect@example.com",
      attendeeName: "Prospect",
    };

    await subject.createEvent(input);
    await subject.updateEvent("evt-1", input);
    await subject.deleteEvent("evt-1");

    for (const call of (global.fetch as jest.Mock).mock.calls) {
      expect(String(call[0])).not.toContain("sendUpdates");
    }
  });
});
