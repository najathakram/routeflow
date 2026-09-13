import {
  annualPrice,
  annualEffectivePerMo,
  annualSaving,
  cyclePrice,
  prorateDaily,
  daysBetween,
  addMonthsUtc,
  addCycle,
} from "./billing-math";

describe("billing-math — subscription money (regression lock)", () => {
  describe("annualPrice = monthly × 10 (exact)", () => {
    it.each([
      [99, 990],
      [249, 2490],
      [499, 4990],
      [12, 120],
      [19, 190],
    ])("monthly $%d → annual $%d", (m, y) => {
      expect(annualPrice(m)).toBe(y);
    });
  });

  describe("annualEffectivePerMo = whole-dollar round(monthly×10/12) — matches pricing.html", () => {
    it.each([
      [99, 83],
      [249, 208],
      [499, 416], // 415.83 rounds UP to 416, never floors to 415
    ])("monthly $%d → $%d/mo billed annually", (m, eff) => {
      expect(annualEffectivePerMo(m)).toBe(eff);
    });
  });

  it("annualSaving is exactly two months", () => {
    expect(annualSaving(99)).toBe(198);
    expect(annualSaving(499)).toBe(998);
  });

  it("cyclePrice picks monthly vs annual", () => {
    expect(cyclePrice(249, "MONTHLY")).toBe(249);
    expect(cyclePrice(249, "ANNUAL")).toBe(2490);
  });

  describe("prorateDaily (30-day cycle, 16 days remaining) — spec figures", () => {
    it.each([
      [12, 6.4], // SEAT_EXTRA
      [15, 8.0], // ROUTE_EXTRA
      [39, 20.8], // REGULATED_ITEMS (RF-2026-0208)
      [49, 26.13], // BUYER_PORTAL
    ])("monthly $%d → prorated $%s", (m, expected) => {
      expect(prorateDaily(m, 16, 30)).toBe(expected);
    });

    it("clamps daysRemaining to [0, daysInCycle]", () => {
      expect(prorateDaily(30, 40, 30)).toBe(30); // full month, never more
      expect(prorateDaily(30, -5, 30)).toBe(0); // never negative
    });

    it("returns 0 for a non-positive cycle length", () => {
      expect(prorateDaily(30, 10, 0)).toBe(0);
    });

    it("full remaining cycle equals the full monthly price", () => {
      expect(prorateDaily(99, 30, 30)).toBe(99);
    });
  });

  describe("daysBetween (UTC, ceil, never negative)", () => {
    it("counts remaining days", () => {
      expect(daysBetween(new Date("2026-07-15T00:00:00Z"), new Date("2026-07-31T00:00:00Z"))).toBe(
        16,
      );
    });
    it("never negative", () => {
      expect(daysBetween(new Date("2026-07-31T00:00:00Z"), new Date("2026-07-15T00:00:00Z"))).toBe(
        0,
      );
    });
  });

  // B329: rollCycles() (billing-cron.service.ts) and subscribe()/upgrade()
  // (subscription-mutation.service.ts) each carried their own copy of this "add a
  // month, clamp the day" arithmetic, and the cron's copy had drifted — it dropped
  // the period's time-of-day to midnight and re-derived the clamp day from the
  // ALREADY-CLAMPED previous result, ratcheting a 31st anchor down to the 28th
  // forever after the first short February. This is the single extracted helper;
  // `anchorDay` is the original, never-clamped billing day — pass it explicitly
  // when chaining calls across cycles so a short month's clip does not stick.
  describe("addMonthsUtc / addCycle — cycle advancement, anchor-day preserving (B329)", () => {
    it("without an explicit anchorDay, clamps to `from`'s own day (single, non-repeating add)", () => {
      const from = new Date("2026-01-31T00:00:00.000Z");
      expect(addCycle(from, "MONTHLY").toISOString()).toBe("2026-02-28T00:00:00.000Z");
    });

    it("anchor ratchet: a 2026-01-31 anchor rolled monthly three times lands on Feb 28, Mar 31, Apr 30 — never Feb 28, Mar 28, Apr 28", () => {
      const anchor = 31;
      let d = new Date("2026-01-31T00:00:00.000Z");
      d = addCycle(d, "MONTHLY", anchor);
      expect(d.toISOString()).toBe("2026-02-28T00:00:00.000Z");
      d = addCycle(d, "MONTHLY", anchor);
      expect(d.toISOString()).toBe("2026-03-31T00:00:00.000Z");
      d = addCycle(d, "MONTHLY", anchor);
      expect(d.toISOString()).toBe("2026-04-30T00:00:00.000Z");
    });

    it("leap year: a 31st anchor into a 29-day February lands on Feb 29, then Mar 31", () => {
      const anchor = 31;
      let d = new Date("2028-01-31T00:00:00.000Z");
      d = addCycle(d, "MONTHLY", anchor);
      expect(d.toISOString()).toBe("2028-02-29T00:00:00.000Z");
      d = addCycle(d, "MONTHLY", anchor);
      expect(d.toISOString()).toBe("2028-03-31T00:00:00.000Z");
    });

    it("preserves the period's time-of-day (h/m/s/ms) exactly instead of collapsing to midnight", () => {
      const from = new Date("2026-01-15T09:30:15.250Z");
      expect(addCycle(from, "MONTHLY").toISOString()).toBe("2026-02-15T09:30:15.250Z");
    });

    it("guard: a mid-month, midnight anchor across a normal roll is byte-identical (no clip, no time to lose)", () => {
      const from = new Date("2026-03-15T00:00:00.000Z");
      expect(addCycle(from, "MONTHLY").toISOString()).toBe("2026-04-15T00:00:00.000Z");
    });

    it("annual cycle: a Feb-29 leap anchor survives repeated non-leap clips and returns on the next leap year", () => {
      const anchor = 29;
      let d = new Date("2028-02-29T00:00:00.000Z"); // 2028 leap
      d = addCycle(d, "ANNUAL", anchor);
      expect(d.toISOString()).toBe("2029-02-28T00:00:00.000Z"); // clipped, not leap
      d = addCycle(d, "ANNUAL", anchor);
      expect(d.toISOString()).toBe("2030-02-28T00:00:00.000Z"); // still clipped
      d = addCycle(d, "ANNUAL", anchor);
      expect(d.toISOString()).toBe("2031-02-28T00:00:00.000Z"); // still clipped
      d = addCycle(d, "ANNUAL", anchor);
      expect(d.toISOString()).toBe("2032-02-29T00:00:00.000Z"); // 2032 leap — anchor never ratcheted to 28
    });

    it("addMonthsUtc directly: an explicit anchorDay overrides `from`'s own (already-clamped) day", () => {
      // Simulates the ratchet bug directly: `from` is Feb 28 (already clipped from a 31st
      // anchor); without the anchor param this would clamp to 28 again (the bug). With it,
      // the target month's real length wins.
      const from = new Date("2026-02-28T00:00:00.000Z");
      expect(addMonthsUtc(from, 1, 31).toISOString()).toBe("2026-03-31T00:00:00.000Z");
    });
  });
});
