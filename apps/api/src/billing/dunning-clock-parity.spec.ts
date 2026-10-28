import { DUNNING_CLOCK } from "@routeflow/types";
import {
  DUNNING_D3_HOURS,
  DUNNING_D7_HOURS,
  DUNNING_FINAL_LEAD_HOURS,
  DUNNING_LAST_DAY_HOURS,
  DUNNING_PAUSE_HOURS,
} from "./dunning-config";
import { PAYMENT_FAILED_EMAIL_DEDUPE_DAYS } from "./dunning-config";

/**
 * SA-1037 r2 PR-6 (L-261): the dunning clock has ONE shape on both sides of the wire. The web banner imports
 * `DUNNING_CLOCK` from @routeflow/types; the API keeps its literals in dunning-config.ts. This pins them equal, so a
 * clock moved on one side fails here instead of showing "read-only tomorrow" on the wrong day.
 */
describe("DUNNING_CLOCK parity (API dunning-config = @routeflow/types)", () => {
  it("the API literals equal the shared clock", () => {
    expect(DUNNING_CLOCK).toEqual({
      d3Hours: DUNNING_D3_HOURS,
      d7Hours: DUNNING_D7_HOURS,
      lastDayHours: DUNNING_LAST_DAY_HOURS,
      finalLeadHours: DUNNING_FINAL_LEAD_HOURS,
      pauseHours: DUNNING_PAUSE_HOURS,
      graceDays: DUNNING_PAUSE_HOURS / 24,
    });
  });

  it("the pause is on day 14, the last day derived from it, the reminders on D3 and D7", () => {
    expect(DUNNING_PAUSE_HOURS).toBe(336);
    expect(DUNNING_LAST_DAY_HOURS).toBe(312);
    expect(DUNNING_LAST_DAY_HOURS).toBe(DUNNING_PAUSE_HOURS - DUNNING_FINAL_LEAD_HOURS);
    expect(DUNNING_D3_HOURS).toBe(72);
    expect(DUNNING_D7_HOURS).toBe(168);
  });

  it("G-j: the failed-payment email dedupe stays 7 days (independent of the pause hours)", () => {
    expect(PAYMENT_FAILED_EMAIL_DEDUPE_DAYS).toBe(7);
  });
});
