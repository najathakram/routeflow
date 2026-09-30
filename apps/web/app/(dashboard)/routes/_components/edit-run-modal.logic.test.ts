/**
 * EditRunModal calendar-date defects (B59).
 *
 * T1 is host-zone-independent: `readCalendarInput` reads the calendar day straight off the
 * ISO string via `calendarDateFromIso`, never through a local-zone getter, so this oracle
 * cannot pass on a UTC host by accident (unlike the old local-getter body, which was only
 * wrong for a negative-UTC-offset host). The zone-driven proof of B59's read half — that a
 * negative-UTC-offset (America/Los_Angeles) viewer sees the run's own day, not the day
 * before — lives in e2e spec 34 flow 1 (`timezoneId` America/Los_Angeles) and the EditRunModal
 * RTL test. T2 below is the host-independent guard for B59's write half.
 */
import { readCalendarInput, buildRunPatchBody } from "./edit-run-modal.logic";

describe("readCalendarInput", () => {
  it("REG-B59 pre-fills the run's own stored calendar date", () => {
    // T1: a UTC-midnight scheduledDate must pre-fill its OWN calendar day, read straight
    // off the ISO string — not derived through any local-zone calendar getter.
    const result = readCalendarInput("2026-06-10T00:00:00.000Z");
    expect(result).toBe("2026-06-10");
  });
});

describe("buildRunPatchBody", () => {
  it("REG-B59 omits scheduledDate from the PATCH when the date field is unchanged", () => {
    // T2: today's body always includes scheduledDate whenever !isInProgress, with no
    // dirty check of `date` against the seeded `initialDate` — so merely opening the
    // modal and saving a driver change rewrites the run's date.
    const body = buildRunPatchBody({
      id: "r1",
      driverId: "d2",
      initialDriverId: "d1",
      date: "2026-06-10",
      initialDate: "2026-06-10",
      notes: "x",
      isInProgress: false,
    });
    expect(body.scheduledDate).toBeUndefined();
  });
});
