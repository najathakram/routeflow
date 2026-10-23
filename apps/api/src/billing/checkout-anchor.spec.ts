import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { nextBoundaryAfter } from "./rf-invoice/calendar-windows";
import {
  CHECKOUT_MAX_LIFETIME_MS,
  MIN_ANCHOR_LEAD_MS,
  checkoutAnchorParams,
  nextCheckoutAnchor,
  planCheckoutAnchor,
} from "./checkout-anchor";

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("SA-733 D6 / M6 — the checkout billing anchor (pure)", () => {
  it.each([
    ["Oct 15 -> Nov 1 12:00Z", "2026-10-15T09:00:00Z", "2026-11-01T12:00:00.000Z"],
    ["Oct 31 23:00Z -> Nov 1 12:00Z", "2026-10-31T23:00:00Z", "2026-11-01T12:00:00.000Z"],
    ["Dec 15 -> Jan 1 (year roll)", "2026-12-15T09:00:00Z", "2027-01-01T12:00:00.000Z"],
    ["Dec 31 23:59Z -> Jan 1 12:00Z", "2026-12-31T23:59:00Z", "2027-01-01T12:00:00.000Z"],
    // On the 1st: the anchor is never omitted. After noon it is next month's 1st ...
    ["on the 1st after noon -> next 1st", "2026-11-01T15:00:00Z", "2026-12-01T12:00:00.000Z"],
    ["exactly Nov 1 12:00:00Z -> Dec 1", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00.000Z"],
    // ... and the anchor is NEVER pushed to the following 1st (a month and more out: Stripe rejects it). A start
    // under MIN_ANCHOR_LEAD_MS before it is refused by planCheckoutAnchor instead (below).
    [
      "Nov 1 10:31Z (89 min) -> still Nov 1 12:00Z",
      "2026-11-01T10:31:00Z",
      "2026-11-01T12:00:00.000Z",
    ],
    [
      "Nov 1 10:29Z (exactly 91 min) -> Nov 1 12:00Z",
      "2026-11-01T10:29:00Z",
      "2026-11-01T12:00:00.000Z",
    ],
    ["Nov 1 08:00Z (4 h) -> Nov 1 12:00Z", "2026-11-01T08:00:00Z", "2026-11-01T12:00:00.000Z"],
    ["Feb 28 -> Mar 1 (short month)", "2027-02-28T12:00:00Z", "2027-03-01T12:00:00.000Z"],
  ])("%s", (_name, now, expected) => {
    expect(iso(nextCheckoutAnchor(at(now)))).toBe(expected);
  });

  it("a plan's anchor is always >= the minimum lead ahead and never more than a month out, whatever the instant", () => {
    let refused = 0;
    for (let m = 0; m < 24 * 62 * 60; m += 11) {
      const now = new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + m * 60_000 + 13_000);
      let plan;
      try {
        plan = planCheckoutAnchor(now);
      } catch {
        refused++;
        continue;
      }
      expect(plan.anchorAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(MIN_ANCHOR_LEAD_MS);
      expect(plan.anchorAt.getTime() - now.getTime()).toBeLessThanOrEqual(32 * 24 * 3600_000);
      expect(plan.anchorAt.getUTCDate()).toBe(1);
      expect(plan.anchorAt.getUTCHours()).toBe(12);
    }
    expect(refused).toBeGreaterThan(0); // the window exists
  });

  describe("F3: the window before the 1st 12:00Z is REFUSED, never anchored a month out", () => {
    const refusal = (now: string) => {
      try {
        planCheckoutAnchor(at(now));
      } catch (e) {
        return e as ConflictException;
      }
      throw new Error("expected a refusal");
    };

    it.each([
      ["Nov 1 10:31Z (89 min)", "2026-11-01T10:31:00Z"],
      ["Nov 1 10:30Z (90 min)", "2026-11-01T10:30:00Z"],
      ["Nov 1 11:59:59Z", "2026-11-01T11:59:59Z"],
      ["Dec 1 11:00Z", "2026-12-01T11:00:00Z"],
    ])("%s -> 409 CHECKOUT_ANCHOR_WINDOW with retryAt = the 1st 12:01Z", (_n, now) => {
      const e = refusal(now);
      expect(e.getStatus()).toBe(409);
      const body = e.getResponse() as { code: string; retryAt: string };
      expect(body.code).toBe(API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW);
      const boundary = nextBoundaryAfter(at(now));
      expect(body.retryAt).toBe(new Date(boundary.getTime() + 60_000).toISOString());
    });

    it("the first accepted instant is exactly MIN_ANCHOR_LEAD_MS (91 min) before the 1st", () => {
      expect(iso(planCheckoutAnchor(at("2026-11-01T10:29:00Z")).anchorAt)).toBe(
        "2026-11-01T12:00:00.000Z",
      );
    });

    it("the retry time itself (12:01Z on the 1st) is accepted and anchors the NEXT 1st", () => {
      expect(iso(planCheckoutAnchor(at("2026-11-01T12:01:00Z")).anchorAt)).toBe(
        "2026-12-01T12:00:00.000Z",
      );
    });
  });

  // SA-832 row 452 (a): the boundary instants of the 91-minute lead, pinned THROUGH planCheckoutAnchor (the one
  // function the plan creator calls) - on the 1st of a 31-day month (Nov) and of a short one (Feb).
  describe("SA-832 / 452 (a): the boundary pins, through planCheckoutAnchor", () => {
    const refused = (now: string) => {
      let caught: unknown;
      try {
        planCheckoutAnchor(at(now));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const body = (caught as ConflictException).getResponse() as { code: string; retryAt: string };
      expect(body.code).toBe(API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW);
      return body;
    };

    it("Nov 1 10:29:01Z (90 min 59 s before the anchor, one second short of the lead): refused, retryAt 12:01Z", () => {
      expect(refused("2026-11-01T10:29:01Z").retryAt).toBe("2026-11-01T12:01:00.000Z");
    });

    it.each([
      [
        "Nov 1 12:00:00Z (exactly on the anchor)",
        "2026-11-01T12:00:00Z",
        "2026-12-01T12:00:00.000Z",
      ],
      ["Nov 1 12:00:01Z", "2026-11-01T12:00:01Z", "2026-12-01T12:00:00.000Z"],
    ])("%s: accepted, the anchor is NEXT month's 1st", (_n, now, anchor) => {
      const plan = planCheckoutAnchor(at(now));
      expect(iso(plan.anchorAt)).toBe(anchor);
      expect(plan.billingCycleAnchor).toBe(Date.parse(anchor) / 1000);
    });

    it("Feb 1 10:30:00Z (90 min before the anchor): refused, retryAt Feb 1 12:01Z", () => {
      expect(refused("2027-02-01T10:30:00Z").retryAt).toBe("2027-02-01T12:01:00.000Z");
    });

    it("Feb 1 12:00:01Z: accepted, the anchor is Mar 1 (28 days out: the short month)", () => {
      const now = at("2027-02-01T12:00:01Z");
      const plan = planCheckoutAnchor(now);
      expect(iso(plan.anchorAt)).toBe("2027-03-01T12:00:00.000Z");
      expect(plan.anchorAt.getTime() - now.getTime()).toBeLessThan(28 * 24 * 3600_000);
    });

    it("the lead is exact to the second: 91 min 00 s before the anchor is accepted, 90 min 59 s is not", () => {
      expect(iso(planCheckoutAnchor(at("2026-11-01T10:29:00Z")).anchorAt)).toBe(
        "2026-11-01T12:00:00.000Z",
      );
      refused("2026-11-01T10:29:01Z");
    });
  });

  // SA-832 row 452 (b): the sweep above only walks Oct-Nov and bounds the anchor by 32 days, which a 28-day February
  // would never notice. Stripe's rule is "within the first billing period": ONE CALENDAR MONTH from now (Jan 31 + 1
  // month is Feb 28, not Mar 3). The sweep now covers Jan-Mar of a common year AND of a leap year.
  describe("SA-832 / 452 (b): Jan-Mar sweep, anchor <= now + 1 CALENDAR month", () => {
    /** `now` plus one calendar month in UTC, the day clamped to the target month's length (Stripe's month arithmetic). */
    const plusOneCalendarMonth = (now: Date): Date => {
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth() + 1;
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return new Date(
        Date.UTC(
          y,
          m,
          Math.min(now.getUTCDate(), lastDay),
          now.getUTCHours(),
          now.getUTCMinutes(),
          now.getUTCSeconds(),
          now.getUTCMilliseconds(),
        ),
      );
    };

    it("the helper clamps like Stripe (Jan 31 -> Feb 28 / 29), so the bound below is the real one", () => {
      expect(iso(plusOneCalendarMonth(at("2027-01-31T15:00:00Z")))).toBe(
        "2027-02-28T15:00:00.000Z",
      );
      expect(iso(plusOneCalendarMonth(at("2028-01-31T15:00:00Z")))).toBe(
        "2028-02-29T15:00:00.000Z",
      );
      expect(iso(plusOneCalendarMonth(at("2027-02-01T12:00:01Z")))).toBe(
        "2027-03-01T12:00:01.000Z",
      );
    });

    it.each([
      ["2027 (Feb has 28 days)", Date.UTC(2027, 0, 1)],
      ["2028 (leap: Feb has 29 days)", Date.UTC(2028, 0, 1)],
    ])(
      "%s: every accepted instant anchors on a 1st 12:00Z within one calendar month",
      (_n, start) => {
        const end = start + 91 * 24 * 3600_000; // Jan 1 -> Apr 1 (Jan + Feb + Mar)
        let accepted = 0;
        let refused = 0;
        for (let t = start + 13_000; t < end; t += 7 * 60_000) {
          const now = new Date(t);
          let plan;
          try {
            plan = planCheckoutAnchor(now);
          } catch (e) {
            expect(e).toBeInstanceOf(ConflictException);
            refused++;
            continue;
          }
          accepted++;
          expect(plan.anchorAt.getUTCDate()).toBe(1);
          expect(plan.anchorAt.getUTCHours()).toBe(12);
          expect(plan.anchorAt.getTime()).toBeGreaterThanOrEqual(
            now.getTime() + MIN_ANCHOR_LEAD_MS,
          );
          expect(plan.anchorAt.getTime()).toBeLessThanOrEqual(plusOneCalendarMonth(now).getTime());
        }
        expect(accepted).toBeGreaterThan(0);
        expect(refused).toBeGreaterThan(0); // the Jan 1 / Feb 1 / Mar 1 windows exist
      },
    );
  });

  describe("session expiry — min(now + 23 h, anchor - 60 min)", () => {
    it("Oct 15: the plain 23 h", () => {
      const now = at("2026-10-15T09:00:00Z");
      const p = planCheckoutAnchor(now);
      expect(p.expiresAt).toBe(Math.floor((now.getTime() + CHECKOUT_MAX_LIFETIME_MS) / 1000));
    });

    it("Oct 31 23:00Z: expires no later than 11:00Z on Nov 1 (before the anchor)", () => {
      const p = planCheckoutAnchor(at("2026-10-31T23:00:00Z"));
      expect(iso(p.anchorAt)).toBe("2026-11-01T12:00:00.000Z");
      expect(p.expiresAt * 1000).toBeLessThanOrEqual(at("2026-11-01T11:00:00Z").getTime());
    });

    it("an expired session cannot complete: expiry is always before the anchor and >= 30 min out (Stripe's floor)", () => {
      for (let h = 0; h < 24 * 62; h += 5) {
        const now = new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + h * 3600_000 + 41 * 60_000);
        let p;
        try {
          p = planCheckoutAnchor(now);
        } catch {
          continue; // inside the refused window
        }
        expect(p.expiresAt * 1000).toBeLessThanOrEqual(p.anchorAt.getTime() - 60 * 60_000);
        expect(p.expiresAt * 1000).toBeGreaterThanOrEqual(now.getTime() + 30 * 60_000 - 1000);
        expect(p.expiresAt * 1000).toBeLessThanOrEqual(now.getTime() + CHECKOUT_MAX_LIFETIME_MS);
      }
    });
  });

  it("the Stripe fragment: epoch seconds + create_prorations", () => {
    const p = planCheckoutAnchor(at("2026-10-15T09:00:00Z"));
    expect(checkoutAnchorParams(p)).toEqual({
      billing_cycle_anchor: Date.UTC(2026, 10, 1, 12) / 1000,
      proration_behavior: "create_prorations",
    });
  });
});
