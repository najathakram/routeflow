import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByText(/choose a demo time/i)).toBeInTheDocument();
  });
});
