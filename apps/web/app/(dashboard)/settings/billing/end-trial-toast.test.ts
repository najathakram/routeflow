import { endTrialToast } from "./end-trial-toast";

describe("endTrialToast", () => {
  it("a locked-at-once answer keeps today's copy", () => {
    expect(endTrialToast({ cancelled: "trial" })).toEqual({ title: "Trial ended" });
    expect(endTrialToast({ cancelled: "already_read_only" })).toEqual({ title: "Trial ended" });
  });

  it("a recorded request (automatic locks paused) says so and does not claim the trial ended", () => {
    const t = endTrialToast({ cancelled: "trial_recorded" });
    expect(t.title).toBe("Request received");
    expect(t.description).toMatch(/stays as it is for now/);
    expect(t.title).not.toMatch(/ended/i);
  });

  it("an empty or odd body falls back to today's copy", () => {
    for (const body of [undefined, null, "", 0, {}, { cancelled: 1 }]) {
      expect(endTrialToast(body)).toEqual({ title: "Trial ended" });
    }
  });
});
