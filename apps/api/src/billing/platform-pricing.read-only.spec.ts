/**
 * W-810: `checkoutPriceData(..., { readOnly: true })` - used by the catch-up plan(), the census dry run and the
 * tenant-facing payment-due read - names the plan product by its deterministic id and makes ZERO Stripe calls,
 * so a Stripe blip cannot hide an owed bill and a dry run cannot create products.
 */
import { PlatformPricingService } from "./platform-pricing.service";
import { fakeStripeProducts } from "../testing/fake-stripe-products";

function makeSvc() {
  const fake = fakeStripeProducts();
  const svc = new PlatformPricingService(
    {} as any,
    {} as any,
    { client: { products: fake.products } } as any,
  );
  jest.spyOn(svc, "resolveTenantPricing").mockResolvedValue({
    planKey: "GROWTH",
    planName: "Growth",
    currency: "usd",
    monthly: 249,
    annual: 2490,
  } as any);
  return { svc, fake };
}

describe("checkoutPriceData readOnly", () => {
  it("returns rf_plan_<code> and calls no Stripe product method", async () => {
    const { svc, fake } = makeSvc();
    const pd = await svc.checkoutPriceData("t1", "month", undefined, { readOnly: true });
    expect(pd).toMatchObject({ product: "rf_plan_growth", unit_amount: 24900 });
    expect(fake.products.retrieve).not.toHaveBeenCalled();
    expect(fake.products.create).not.toHaveBeenCalled();
    expect(fake.products.update).not.toHaveBeenCalled();
  });

  it("the default (checkout/open) still ensures the product", async () => {
    const { svc, fake } = makeSvc();
    await svc.checkoutPriceData("t1", "month");
    expect(fake.table.get("rf_plan_growth")?.active).toBe(true);
  });
});
