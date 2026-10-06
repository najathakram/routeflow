import * as fs from "fs";
import * as path from "path";
import {
  STRIPE_API_VERSION,
  isLiveStripeSubscriptionStatus,
  stripeSubscriptionPeriod,
} from "./stripe-period";

// #2436 (P0): the Stripe API version is pinned, and the period is read the way dahlia shapes it.
describe("stripe-period", () => {
  it("STRIPE_API_VERSION equals the installed SDK's own ApiVersion (an SDK bump must be deliberate)", () => {
    const sdkDir = path.dirname(require.resolve("stripe")); // …/stripe/cjs
    const src = fs.readFileSync(path.join(sdkDir, "apiVersion.js"), "utf8");
    const sdkVersion = src.match(/ApiVersion = '([^']+)'/)?.[1];
    expect(sdkVersion).toBe(STRIPE_API_VERSION);
  });

  it("every Stripe client constructor pins that apiVersion", () => {
    const root = path.resolve(__dirname, "..");
    for (const rel of [
      "billing/stripe.service.ts",
      "payment-requests/provider/stripe-payment-provider.ts",
      "stripe-connect/provider/stripe-connect-oauth.provider.ts",
    ]) {
      const code = fs.readFileSync(path.join(root, rel), "utf8");
      const ctors = code.match(/new Stripe\([^)]*\)/g) ?? [];
      expect(ctors.length).toBeGreaterThan(0);
      for (const c of ctors) expect(c).toContain("apiVersion: STRIPE_API_VERSION");
    }
  });

  it("reads the period from items.data[0] (dahlia)", () => {
    expect(
      stripeSubscriptionPeriod({
        items: {
          data: [{ current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 }],
        },
      }),
    ).toEqual({ periodStart: new Date(1_700_000_000_000), periodEnd: new Date(1_702_000_000_000) });
  });

  it("items win over a stale top-level field; the top level is only a fallback", () => {
    const p = stripeSubscriptionPeriod({
      current_period_start: 1,
      current_period_end: 2,
      items: { data: [{ current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 }] },
    });
    expect(p?.periodStart).toEqual(new Date(1_700_000_000_000));
    expect(stripeSubscriptionPeriod({ current_period_start: 10, current_period_end: 20 })).toEqual({
      periodStart: new Date(10_000),
      periodEnd: new Date(20_000),
    });
  });

  it("null — never an Invalid Date — when no real epoch exists anywhere", () => {
    expect(stripeSubscriptionPeriod({})).toBeNull();
    expect(stripeSubscriptionPeriod(null)).toBeNull();
    expect(stripeSubscriptionPeriod({ items: { data: [] } })).toBeNull();
    expect(
      stripeSubscriptionPeriod({ current_period_start: "x", current_period_end: NaN }),
    ).toBeNull();
  });

  // #2440 N2 (Opus on #2446, SA-452 LOW): an add-on item (TenantAddon.stripeItemId) is never the
  // period source when the base-plan item is present.
  it("reads the base-plan item, skipping known add-on items", () => {
    const sub = {
      items: {
        data: [
          {
            id: "si_addon",
            current_period_start: 1_600_000_000,
            current_period_end: 1_600_100_000,
          },
          { id: "si_base", current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 },
        ],
      },
    };
    expect(stripeSubscriptionPeriod(sub, new Set(["si_addon"]))).toEqual({
      periodStart: new Date(1_700_000_000 * 1000),
      periodEnd: new Date(1_702_000_000 * 1000),
    });
  });

  it("falls back to the first item when every item is a known add-on", () => {
    const sub = {
      items: { data: [{ id: "si_addon", current_period_start: 1, current_period_end: 2 }] },
    };
    expect(stripeSubscriptionPeriod(sub, new Set(["si_addon"]))?.periodEnd).toEqual(new Date(2000));
  });

  // The ONE liveness predicate shared by the checkout guard, the completion's X1 guard and the duplicate verdict.
  describe("isLiveStripeSubscriptionStatus", () => {
    it.each(["active", "trialing", "past_due", "unpaid"])(
      "%s is live (it still bills or keeps trying to)",
      (s) => {
        expect(isLiveStripeSubscriptionStatus(s)).toBe(true);
      },
    );

    it.each([
      "incomplete",
      "incomplete_expired",
      "canceled",
      "paused",
      "unknown_status",
      "",
      undefined,
      null,
      7,
    ])(
      "%p is NOT live — `paused` deliberately so (SA ruling: it collects nothing until resumed, so a new checkout is a way forward, not a second bill)",
      (s) => {
        expect(isLiveStripeSubscriptionStatus(s)).toBe(false);
      },
    );
  });
});
