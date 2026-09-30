/**
 * PIN (no REG token — deliberately OUTSIDE the red gate).
 *
 * `fmtCalendarDate` is already UTC-anchored (`formatting.ts:57-65` passes
 * `timeZone: "UTC"`), so this assertion is zone-independent and green both before and
 * after the B91-web fix. It is kept as a pin: WP-WEB migrates nine call sites ONTO this
 * function, so a regression in its UTC anchoring would silently reintroduce B91.
 *
 * The previous version of this file carried a `REG-B91` token and a second assertion
 * comparing against the LOCAL formatter (`fmtDate`). Both were removed by the
 * test-remediation round: the REG token put a test that cannot fail inside the red gate,
 * and the `fmtDate` comparator asserted today's soon-to-be-replaced behavior while being
 * dependent on the host machine's timezone (its `process.env.TZ` pin is inert under Jest).
 * The real B91-web regression test now lives at
 * `app/(dashboard)/customers/_components/authorizations-expiry.logic.test.ts`.
 */
import { fmtCalendarDate, fmtCalendarDateWithWeekday } from "./formatting";

describe("fmtCalendarDate", () => {
  it("renders a UTC-midnight calendar date as its own day, in any viewer timezone", () => {
    expect(fmtCalendarDate("2026-11-01T00:00:00.000Z")).toBe("Nov 1, 2026");
  });
});

describe("fmtCalendarDateWithWeekday", () => {
  it("renders the UTC calendar day (short style), not the previous day", () => {
    expect(fmtCalendarDateWithWeekday("2026-06-10T00:00:00.000Z", "short")).toMatch(/\b10\b/);
    expect(fmtCalendarDateWithWeekday("2026-06-10T00:00:00.000Z", "short")).not.toMatch(/\b9\b/);
  });

  it("renders the UTC calendar day (long style), not the previous day", () => {
    expect(fmtCalendarDateWithWeekday("2026-06-10T00:00:00.000Z", "long")).toMatch(/\b10\b/);
    expect(fmtCalendarDateWithWeekday("2026-06-10T00:00:00.000Z", "long")).not.toMatch(/\b9\b/);
  });

  it("returns the same fallback as fmtCalendarDate for empty input", () => {
    expect(fmtCalendarDateWithWeekday(null, "short")).toBe(fmtCalendarDate(null));
    expect(fmtCalendarDateWithWeekday(undefined, "long")).toBe(fmtCalendarDate(undefined));
  });
});
