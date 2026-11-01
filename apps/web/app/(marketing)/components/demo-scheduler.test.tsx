import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DemoScheduler } from "./demo-scheduler";

// Availability-load error handling. `DemoBookingService.getAvailability`
// never throws (every fail-closed branch resolves with `days: []`), so a
// thrown error here is always a transport-level failure — a routing
// mismatch, a network drop, a raw 500 — never one of the API's own curated
// messages. The regression this pins: a real 404 from a mismatched/foreign
// server returns NestJS's own `Cannot GET /api/v1/public/demo-bookings/...`
// body, and that text must never reach the page verbatim.

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("DemoScheduler — availability load errors", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  it("shows a fixed generic message on a raw framework 404, never the response body (regression)", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          statusCode: 404,
          message: "Cannot GET /api/v1/public/demo-bookings/availability?from=...",
          error: "Not Found",
        },
        404,
      ),
    );

    render(<DemoScheduler />);

    await waitFor(() => {
      expect(screen.getByText(/we could not load available times/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/cannot get/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/api\/v1/i)).not.toBeInTheDocument();
  });

  it("shows the same generic message on a bare network failure", async () => {
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));

    render(<DemoScheduler />);

    await waitFor(() => {
      expect(screen.getByText(/we could not load available times/i)).toBeInTheDocument();
    });
  });

  it("shows the same generic message on a 500 with a framework body", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ statusCode: 500, message: "Internal server error" }, 500),
    );

    render(<DemoScheduler />);

    await waitFor(() => {
      expect(screen.getByText(/we could not load available times/i)).toBeInTheDocument();
    });
  });

  it("renders the calendar grid, not an error, once availability loads", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ timeZone: "America/Chicago", durationMinutes: 30, days: [] }),
    );

    render(<DemoScheduler />);

    await waitFor(() => {
      expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Pick a time" })).toBeInTheDocument();
  });
});

// B502 — the availability response's `status` field distinguishes "the
// booking system is broken" from "this window is genuinely fully booked".
// Both render an empty grid, so only the message below it tells them apart.
describe("DemoScheduler — availability status (B502)", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  it('shows an honest "temporarily unavailable" message with a contact email when status is "unavailable"', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        status: "unavailable",
        timeZone: "America/Chicago",
        durationMinutes: 30,
        days: [],
      }),
    );

    render(<DemoScheduler />);

    await waitFor(() => {
      expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /hello@routeflow\.info/i })).toHaveAttribute(
      "href",
      "mailto:hello@routeflow.info",
    );
    // Never claims the calendar is full when the system itself is down.
    expect(screen.queryByText(/no times are available/i)).not.toBeInTheDocument();
  });

  it('shows the "no free times" message, not "unavailable", when status is "ok" with an empty grid', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ status: "ok", timeZone: "America/Chicago", durationMinutes: 30, days: [] }),
    );

    render(<DemoScheduler />);

    await waitFor(() => {
      expect(screen.getByText(/no times are available this month/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
  });
});

// W6 — the call calendar (COPY.md 2n). The clock is fixed on Oct 31, the last day of a month, in
// America/Chicago, the day before the Nov 1 clock change.
jest.mock("../lib/demo-booking", () => ({
  ...jest.requireActual("../lib/demo-booking"),
  visitorTimeZone: () => "America/Chicago",
}));

describe("DemoScheduler — W6 (clock fixed at Oct 31)", () => {
  let fetchSpy: jest.Mock;
  // The month heading (the only h3 that ends in a year).
  const monthShown = () => screen.getByRole("heading", { level: 3, name: /\b20\d\d$/ }).textContent;
  const NOVEMBER_DAYS = [
    {
      date: "2026-11-03",
      slots: [
        { startsAt: "2026-11-03T15:00:00.000Z", endsAt: "2026-11-03T15:30:00.000Z" },
        { startsAt: "2026-11-03T16:00:00.000Z", endsAt: "2026-11-03T16:30:00.000Z" },
      ],
    },
    {
      date: "2026-11-04",
      slots: [{ startsAt: "2026-11-04T15:00:00.000Z", endsAt: "2026-11-04T15:30:00.000Z" }],
    },
  ];

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date("2026-10-31T17:00:00.000Z"),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    fetchSpy = jest.fn(async (url: string) => {
      const from = new URL(url, "http://x").searchParams.get("from") ?? "";
      // October has no times left; November has some.
      const days = from.startsWith("2026-10") ? [] : NOVEMBER_DAYS;
      return jsonResponse({ status: "ok", timeZone: "America/Chicago", durationMinutes: 30, days });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("C4: at the end of a month with no times left, opens on the first month that has times", async () => {
    render(<DemoScheduler />);

    await waitFor(() => expect(monthShown()).toBe("November 2026"));
    const grid = screen.getByRole("group", { name: /available dates in november 2026/i });
    const openDates = () =>
      within(grid)
        .getAllByRole("button")
        .filter((b) => !(b as HTMLButtonElement).disabled)
        .map((b) => b.textContent);
    await waitFor(() => expect(openDates()).toEqual(["3", "4"]));
    expect(screen.queryByText(/no times are available/i)).not.toBeInTheDocument();
  });

  it("C4: the visitor can still go back a month and forward again", async () => {
    const user = userEvent.setup();
    render(<DemoScheduler />);
    await waitFor(() => expect(monthShown()).toBe("November 2026"));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(monthShown()).toBe("October 2026"));
    expect(await screen.findByText(/no times are available this month/i)).toBeInTheDocument();
  });

  it("C4: when no month ahead has times either, it stays on this month and says so", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ status: "ok", timeZone: "America/Chicago", durationMinutes: 30, days: [] }),
    );
    render(<DemoScheduler />);
    expect(await screen.findByText(/no times are available this month/i)).toBeInTheDocument();
    await waitFor(() => expect(monthShown()).toBe("October 2026"));
  });

  it("C5: one plain line about the time zone, with no zone abbreviation that a clock change can contradict", async () => {
    const user = userEvent.setup();
    const { container } = render(<DemoScheduler />);
    // Whatever month it opens on, go to November: the line must read the same there.
    await waitFor(() => expect(screen.queryByText(/loading available times/i)).toBeNull());
    if (monthShown() !== "November 2026") {
      await user.click(screen.getByRole("button", { name: "Next month" }));
      await waitFor(() => expect(monthShown()).toBe("November 2026"));
    }

    const line = container.querySelector("#booking-title + p");
    expect(line?.textContent).toBe("Times are in your time zone. Each call is 30 minutes long.");
    expect(screen.getByRole("heading", { name: "Pick a time" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Times shown in|walkthrough|\bdemo\b/i);

    // A November slot, shown while the clock still reads October, carries no zone name either.
    await user.click(screen.getByRole("button", { name: /Tuesday, November 3.*times available/i }));
    expect(screen.getByRole("button", { name: "9:00 AM" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b(CDT|CST|EDT|EST|PDT|PST|GMT|UTC)\b/);
  });

  it("2n: the no-times line has a real mailto link, and the empty prompt is the new words", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ status: "ok", timeZone: "America/Chicago", durationMinutes: 30, days: [] }),
    );
    render(<DemoScheduler />);
    const status = await screen.findByText(/no times are available this month/i);
    expect(status.textContent).toBe(
      "No times are available this month. Try next month, or email hello@routeflow.info and we will find a time for you.",
    );
    expect(within(status).getByRole("link", { name: "hello@routeflow.info" })).toHaveAttribute(
      "href",
      "mailto:hello@routeflow.info",
    );
  });
});
