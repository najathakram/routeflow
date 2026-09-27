import * as fs from "fs";
import * as path from "path";
import { STRIPE_API_VERSION, stripeSubscriptionPeriod } from "./stripe-period";

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
});
