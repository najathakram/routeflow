import { describeStub, describeStubPeriod } from "./catchup-plan";
import { PlatformPricingService } from "./platform-pricing.service";

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

  it("the plan product name is 'RouteFlow {plan}' for both intervals", async () => {
    const pricing = {
      resolveTenantPricing: jest.fn().mockResolvedValue({
        planName: "Enterprise",
        currency: "usd",
        monthly: 100,
        annual: 1000,
      }),
    };
    const svc = Object.create(PlatformPricingService.prototype) as PlatformPricingService;
    (svc as any).resolveTenantPricing = pricing.resolveTenantPricing;
    const month = await svc.checkoutPriceData("t1", "month");
    const year = await svc.checkoutPriceData("t1", "year");
    expect(month.product_data.name).toBe("RouteFlow Enterprise");
    expect(year.product_data.name).toBe("RouteFlow Enterprise");
    expect(month.recurring).toEqual({ interval: "month" });
    expect(year.recurring).toEqual({ interval: "year" });
  });
});
