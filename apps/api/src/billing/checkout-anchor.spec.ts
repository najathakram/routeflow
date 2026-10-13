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

  describe("session expiry — min(now + 24 h, anchor - 60 min)", () => {
    it("Oct 15: the plain 24 h", () => {
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
