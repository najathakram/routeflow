import { describeStub, describeStubPeriod } from "./catchup-plan";
import { fakeStripeProducts } from "../testing/fake-stripe-products";
import { PlatformPricingService } from "./platform-pricing.service";
import { planDisplayName } from "@routeflow/pricing";
import { PLAN_KEYS } from "./plan-catalog.constants";

/**
 * What the customer reads on the Stripe Checkout page and receipt: plain words, no em or en dash (owner rule).
 * The interval lives in the price's `recurring` field, never in the product name.
 */
const d = (iso: string) => new Date(iso);
const DASH = /[–—]/;

describe("customer-facing catch-up and plan strings", () => {
  it("the catch-up line reads '{Month YYYY} subscription'", () => {
    expect(describeStub(d("2026-10-01T12:00:00Z"), d("2026-11-01T12:00:00Z"))).toBe(
      "October 2026 subscription",
    );
  });

  it("no catch-up label carries a dash (whole month, several months, mid-month, year-spanning)", () => {
    const labels = [
      describeStub(d("2026-10-01T12:00:00Z"), d("2026-11-01T12:00:00Z")),
      describeStub(d("2026-10-01T12:00:00Z"), d("2026-12-01T12:00:00Z")),
      describeStub(d("2026-11-11T12:00:00Z"), d("2026-12-01T12:00:00Z")),
      describeStub(d("2026-12-10T12:00:00Z"), d("2027-02-01T12:00:00Z")),
      describeStubPeriod(d("2026-10-01T12:00:00Z"), d("2026-11-01T12:00:00Z")),
    ];
    for (const l of labels) expect(l).not.toMatch(DASH);
  });

  it("the period words alone are 'October 2026' (the banner prints them in its sentence)", () => {
    expect(describeStubPeriod(d("2026-10-01T12:00:00Z"), d("2026-11-01T12:00:00Z"))).toBe(
      "October 2026",
    );
  });

  it("the plan product name is the plan name alone for both intervals (SA-1547 Q3)", async () => {
    const pricing = {
      resolveTenantPricing: jest.fn().mockResolvedValue({
        planKey: "ENTERPRISE",
        planName: "Enterprise",
        currency: "usd",
        monthly: 100,
        annual: 1000,
      }),
    };
    const svc = Object.create(PlatformPricingService.prototype) as PlatformPricingService;
    const stripe = fakeStripeProducts();
    (svc as any).stripe = { client: { products: stripe.products } };
    (svc as any).resolveTenantPricing = pricing.resolveTenantPricing;
    const month = await svc.checkoutPriceData("t1", "month");
    const year = await svc.checkoutPriceData("t1", "year");
    // W-810: one shared, named plan product - the name lives on it, not on the line.
    expect(month.product).toBe("rf_plan_enterprise");
    expect(year.product).toBe(month.product);
    expect(stripe.table.get(month.product)?.name).toBe("Enterprise");
    expect(stripe.table.get(month.product)?.name).not.toMatch(DASH);
    expect(month.recurring).toEqual({ interval: "month" });
    expect(year.recurring).toEqual({ interval: "year" });
  });

  it.each([...PLAN_KEYS])(
    "R16: the %s checkout line's product is named planDisplayName alone (no dash, no raw key, no brand)",
    async (planKey) => {
      const svc = Object.create(PlatformPricingService.prototype) as PlatformPricingService;
      const stripe = fakeStripeProducts();
      (svc as any).stripe = { client: { products: stripe.products } };
      (svc as any).resolveTenantPricing = jest.fn().mockResolvedValue({
        planKey,
        planName: planKey,
        currency: "usd",
        monthly: 100,
        annual: 1000,
      });
      const line = await svc.checkoutPriceData("t1", "month");
      const name = stripe.table.get(line.product)?.name;
      expect(name).toBe(planDisplayName(planKey));
      expect(name).not.toMatch(DASH);
      expect(name).not.toContain("RouteFlow");
    },
  );
});
