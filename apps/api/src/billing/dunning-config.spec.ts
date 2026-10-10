import {
  billingPauseMode,
  DUNNING_D3_HOURS,
  DUNNING_D6_HOURS,
  DUNNING_FINAL_LEAD_HOURS,
  DUNNING_MILESTONES,
  DUNNING_PAUSE_HOURS,
  PAUSE_LOCAL_HOUR,
} from "./dunning-config";

describe("dunning-config (SA-733r7 PR-B3)", () => {
  it("names the thresholds the gate fixes: +72 h / +144 h / +168 h, a 24 h final-notice lead, 03:00 local", () => {
    expect(DUNNING_D3_HOURS).toBe(72);
    expect(DUNNING_D6_HOURS).toBe(144);
    expect(DUNNING_PAUSE_HOURS).toBe(168);
    expect(DUNNING_FINAL_LEAD_HOURS).toBe(24);
    expect(PAUSE_LOCAL_HOUR).toBe(3);
  });

  it("keys the reminders d0 / d3 / d6 plus the final and paused notices", () => {
    expect(DUNNING_MILESTONES).toEqual({
      D0: "DUNNING_D0",
      D3: "DUNNING_D3",
      D6: "DUNNING_D6",
      FINAL: "DUNNING_FINAL",
      PAUSED: "DUNNING_PAUSED",
    });
  });

  it("BILLING_PAUSE_MODE defaults to dark; only an exact off / enforced changes it", () => {
    expect(billingPauseMode({})).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "" })).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "dark" })).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "off" })).toBe("off");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: " Enforced " })).toBe("enforced");
  });

  it("a typo can never turn the pause on", () => {
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "enforce" })).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "true" })).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "on" })).toBe("dark");
  });
});
