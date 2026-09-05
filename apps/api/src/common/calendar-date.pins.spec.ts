import { calendarDayBounds, startOfCalendarDay } from "./calendar-date";

/**
 * Pin (no REG token; outside the red gate) — bug-test-plan.md T10.
 *
 * `startOfCalendarDay` has been extracted byte-for-byte out of
 * `invoices.service.ts` into this shared module (`./calendar-date`), with its
 * argument order reversed (`date` first, then `timeZone`) to read naturally at
 * analytics' new call sites. These are the SAME fixtures as
 * `invoices.service.spec.ts`'s "calendar-date helpers" describe block
 * (`:7041-7049`, `:7075-7083`), re-asserted here against the extracted
 * export with the arguments reordered — same instants, same expected
 * outputs, proving the extraction is behavior-preserving.
 */
describe("calendar-date pins — startOfCalendarDay extraction", () => {
  it("dates a same-day sale in the TENANT's calendar day, at UTC midnight", () => {
    // 8:10pm America/New_York on Aug 22 is already Aug 23 in UTC. Storing raw
    // new Date() would print the invoice as Aug 23 — a day after the sale happened.
    const at810pmEdt = new Date("2026-08-23T00:10:00.000Z");
    expect(startOfCalendarDay(at810pmEdt, "America/New_York").toISOString()).toBe(
      "2026-08-22T00:00:00.000Z",
    );
  });

  it("falls back to the UTC day when the tenant timezone is missing or invalid", () => {
    const now = new Date("2026-08-23T00:10:00.000Z");
    expect(startOfCalendarDay(now, null).toISOString()).toBe("2026-08-23T00:00:00.000Z");
    expect(startOfCalendarDay(now, "Not/AZone").toISOString()).toBe("2026-08-23T00:00:00.000Z");
  });
});

/**
 * T12 (mirror pin) — `calendarDayBounds` is triplicated verbatim across
 * `apps/api/src/common/calendar-date.ts`, `apps/web/lib/calendar-date.ts` and
 * `apps/mobile/lib/calendar-date.ts`. These three cases are asserted
 * IDENTICALLY in all three packages so a copy that drifts (or whose
 * `hourCycle`/hour-24 correction breaks) fails here instead of silently
 * handing wrong day boundaries to the first caller added later.
 *
 * Semantics being pinned: the interval is half-open — `end` is the EXCLUSIVE
 * next-day boundary, not 23:59:59.999 — and the second argument is an
 * INSTANT, resolved to a calendar day as observed in `timeZone`.
 */
describe("calendarDayBounds — T12 mirror pin", () => {
  it("returns the plain UTC day for zone UTC", () => {
    const { start, end } = calendarDayBounds("UTC", new Date("2026-06-10T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });

  it("resolves UTC midnight Mar 8 to the PREVIOUS calendar day in America/New_York", () => {
    const { start, end } = calendarDayBounds(
      "America/New_York",
      new Date("2026-03-08T00:00:00.000Z"),
    );
    expect(start.toISOString()).toBe("2026-03-07T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it("spans only 23 hours on the America/New_York spring-forward day", () => {
    const { start, end } = calendarDayBounds(
      "America/New_York",
      new Date("2026-03-08T12:00:00.000Z"),
    );
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
  });
});
