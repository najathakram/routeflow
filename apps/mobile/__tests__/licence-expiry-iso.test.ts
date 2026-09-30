/**
 * Licence-expiry write (B91) — `expiresAt` is written as a LOCAL 23:59:59 instant
 * instead of UTC midnight, so the stored calendar day is wrong for every viewer
 * whose runtime zone is not UTC.
 *
 * RELOCATED by the test-remediation round: this file previously lived beside its
 * seam at `app/(operator)/customers/[id]/licenses.logic.test.ts`, where
 * `apps/mobile/jest.config.js`'s `testMatch: ["**\/__tests__/**\/*.test.ts"]` NEVER
 * COLLECTED it (confirmed absent from `npx jest --listTests`). Mobile specs must
 * live under `__tests__/` to run at all.
 *
 * NO `process.env.TZ` PIN: an in-file assignment is inert under Jest (the worker
 * gets a sandboxed `process.env`, so Node's timezone-reconfiguration hook never
 * fires). It is not needed here — the ORACLE is zone-independent. The correct
 * value is "2027-01-01T00:00:00.000Z" in every zone, and today's local-23:59:59
 * construction cannot produce it in ANY zone: UTC-6 yields
 * "2027-01-02T05:59:59.000Z", UTC-5 yields "2027-01-02T04:59:59.000Z", and even
 * TZ=UTC yields "2027-01-01T23:59:59.000Z". Only the reported RECEIVED value
 * varies by host zone; the test is red everywhere until the fix lands.
 */
import { buildExpiresAtIso } from "../app/(operator)/customers/[id]/licenses.logic";
import { isoFromCalendarDate } from "../lib/calendar-date";

describe("buildExpiresAtIso", () => {
  it("REG-B91 writes UTC midnight for the licence expiry, never a local end-of-day instant", () => {
    expect(buildExpiresAtIso("2027-01-01")).toBe("2027-01-01T00:00:00.000Z");
  });

  // PIN (not REG): the plan's T5 also names the helper the writer now delegates to.
  // Correct by construction, so it carries no REG token — it is here to catch a future
  // rewrite of `isoFromCalendarDate` that reintroduces a clock-dependent construction.
  it("pins isoFromCalendarDate to the UTC-midnight storage convention", () => {
    expect(isoFromCalendarDate("2027-01-01")).toBe("2027-01-01T00:00:00.000Z");
  });
});
