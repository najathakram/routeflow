/**
 * Late-route predicate (B90) — a run scheduled for "today" is flagged as late because the
 * comparison floors the scheduled ISO instant to the RUNTIME's local calendar day, which
 * lands a day early for any negative-UTC-offset viewer.
 *
 * NO `process.env.TZ` PIN: an in-file assignment is inert under Jest (the worker gets a
 * sandboxed `process.env`, so Node's timezone-reconfiguration hook never fires — proved by
 * the RED-gate audit, where `TZ=UTC npx jest run-lateness.test` turned this file GREEN
 * despite its former `process.env.TZ = "America/New_York"` line). The zone is passed as
 * DATA instead, via `isRunPastDue`'s third argument, which now actually drives "today"
 * (via `Intl.DateTimeFormat` in that zone) instead of being discarded — so the red below
 * does not depend on the machine running the suite.
 */
import { isRunPastDue } from "../lib/run-lateness";

const NY = "America/New_York";

describe("isRunPastDue", () => {
  it("REG-B90 does not flag a run scheduled for today as late", () => {
    // 2026-06-10T00:00:00.000Z is the run's stored calendar day; "now" is 09:00 EDT on
    // that same day. Today's local floor reads the scheduled instant as 2026-06-09 in NY.
    const result = isRunPastDue("2026-06-10T00:00:00.000Z", new Date("2026-06-10T13:00:00Z"), NY);
    expect(result).toBe(false);
  });

  // GUARD (not REG): passes today AND after the fix — it holds the opposite direction so
  // the fix cannot simply return false always. Deliberately NOT tagged REG-B, so the
  // `-t "REG-B"` red gate does not select a test that is expected to pass.
  it("GUARD-B90 still flags a genuinely past run as late", () => {
    const result = isRunPastDue("2026-06-08T00:00:00.000Z", new Date("2026-06-10T13:00:00Z"), NY);
    expect(result).toBe(true);
  });

  // REG-B90 (zone-discriminating): identical arguments, opposite zones, opposite verdicts —
  // this is the case that catches a `void timeZone` regression on a UTC CI runner, because
  // the host's own local day (UTC) cannot produce both outcomes from one fixed `now`.
  it("REG-B90 keeps a run current in a zone still on the earlier calendar day", () => {
    // 2026-06-10T03:00:00Z is 2026-06-09 evening in New York (UTC-4) but already
    // 2026-06-10 on a UTC host — a fake zone-agnostic predicate reads it as UTC's day.
    const result = isRunPastDue("2026-06-09T00:00:00.000Z", new Date("2026-06-10T03:00:00Z"), NY);
    expect(result).toBe(false);
  });

  it("REG-B90 flags the same run as late in a zone already on the later calendar day", () => {
    // Auckland (UTC+12/+13) is already 2026-06-11 at this same instant.
    const result = isRunPastDue(
      "2026-06-09T00:00:00.000Z",
      new Date("2026-06-10T03:00:00Z"),
      "Pacific/Auckland",
    );
    expect(result).toBe(true);
  });

  it("falls back to the device-local day on an invalid IANA zone instead of throwing", () => {
    const now = new Date("2026-06-10T13:00:00Z");
    expect(() => isRunPastDue("2026-06-10T00:00:00.000Z", now, "Not/AZone")).not.toThrow();
    expect(isRunPastDue("2026-06-10T00:00:00.000Z", now, "Not/AZone")).toBe(
      isRunPastDue("2026-06-10T00:00:00.000Z", now),
    );
  });
});
