import {
  isPricePushFailure,
  mergeOverride,
  priceOverrideAudit,
  priceOverrideIdempotencyKey,
  prorationAllowedFor,
  prorationBehaviorFor,
  publicPush,
  revertPriceParams,
  sameOverride,
  STRIPE_PRICE_PUSH_STATUSES,
} from "./price-override";

describe("price-override helpers (SA-733 D8 / M7)", () => {
  it("maps the effective mode to the Stripe proration behavior", () => {
    expect(prorationBehaviorFor("next_cycle")).toBe("none");
    expect(prorationBehaviorFor("now_prorated")).toBe("create_prorations");
  });

  it("pushes to every live status including past_due / unpaid, never canceled / incomplete*", () => {
    expect([...STRIPE_PRICE_PUSH_STATUSES].sort()).toEqual(
      ["active", "past_due", "trialing", "unpaid"].sort(),
    );
    expect(prorationAllowedFor("active")).toBe(true);
    expect(prorationAllowedFor("trialing")).toBe(true);
    expect(prorationAllowedFor("past_due")).toBe(false);
    expect(prorationAllowedFor("unpaid")).toBe(false);
  });

  it("only Stripe errors are push failures; a benign skip is not", () => {
    expect(isPricePushFailure({ synced: false, reason: "stripe_update_failed" })).toBe(true);
    expect(isPricePushFailure({ synced: false, reason: "stripe_retrieve_failed" })).toBe(true);
    expect(isPricePushFailure({ synced: false, reason: "stripe_product_create_failed" })).toBe(
      true,
    );
    expect(isPricePushFailure({ synced: false, reason: "no_active_stripe_subscription" })).toBe(
      false,
    );
    expect(isPricePushFailure({ synced: false, reason: "subscription_not_active_canceled" })).toBe(
      false,
    );
    expect(isPricePushFailure({ synced: false, reason: "stripe_not_configured" })).toBe(false);
    expect(isPricePushFailure({ synced: true })).toBe(false);
  });

  it("builds a deterministic idempotency key from tenant, cents, mode, version and item price", () => {
    const base = {
      tenantId: "t1",
      amountCents: 1999,
      effective: "next_cycle" as const,
      version: new Date(5000),
      itemPriceId: "price_1",
    };
    expect(priceOverrideIdempotencyKey(base)).toBe(
      "t1:price-override:1999:next_cycle:v5000:price_1",
    );
    expect(priceOverrideIdempotencyKey({ ...base })).toBe(priceOverrideIdempotencyKey(base));
    const others = [
      { ...base, amountCents: 2000 },
      { ...base, effective: "now_prorated" as const },
      { ...base, version: new Date(6000) },
      { ...base, itemPriceId: "price_2" },
      { ...base, tenantId: "t2" },
    ].map(priceOverrideIdempotencyKey);
    expect(new Set([priceOverrideIdempotencyKey(base), ...others]).size).toBe(6);
    expect(
      priceOverrideIdempotencyKey({ tenantId: "t1", amountCents: 1, effective: "next_cycle" }),
    ).toBe("t1:price-override:1:next_cycle:v0:-");
  });

  it("mergeOverride: undefined keeps the stored column, null clears it, a number sets it", () => {
    const existing = { priceOverrideMonthly: "150.00", priceOverrideAnnual: null };
    expect(mergeOverride(existing, {})).toEqual({ monthly: 150, annual: null });
    expect(mergeOverride(existing, { monthly: null })).toEqual({ monthly: null, annual: null });
    expect(mergeOverride(existing, { annual: 1400 })).toEqual({ monthly: 150, annual: 1400 });
    expect(mergeOverride(null, { monthly: 99 })).toEqual({ monthly: 99, annual: null });
  });

  it("sameOverride compares by value across Decimal-ish and number reads", () => {
    expect(
      sameOverride(
        { priceOverrideMonthly: "150.00", priceOverrideAnnual: null },
        { priceOverrideMonthly: 150 },
      ),
    ).toBe(true);
    expect(sameOverride({ priceOverrideMonthly: 150 }, { priceOverrideMonthly: 149.99 })).toBe(
      false,
    );
    expect(sameOverride(null, { priceOverrideMonthly: null })).toBe(true);
    expect(sameOverride(null, { priceOverrideMonthly: 1 })).toBe(false);
  });

  it("revertPriceParams puts the item back at the previous cents with the same proration", () => {
    expect(
      revertPriceParams({
        subscriptionId: "sub_1",
        itemId: "si_1",
        productId: "prod_1",
        interval: "year",
        previousCents: 120000,
        proration: "create_prorations",
        key: "k",
      }),
    ).toEqual({
      items: [
        {
          id: "si_1",
          price_data: {
            currency: "usd",
            unit_amount: 120000,
            recurring: { interval: "year" },
            product: "prod_1",
          },
        },
      ],
      proration_behavior: "create_prorations",
    });
  });

  it("the audit meta carries the request, effective mode, OLD and NEW price and the push, never the undo handle", () => {
    const undo = {
      subscriptionId: "sub_1",
      itemId: "si_1",
      productId: "prod_1",
      interval: "month" as const,
      previousCents: 10000,
      proration: "none" as const,
      key: "k",
    };
    const sync = { synced: true, oldAmount: 100, newAmount: 80, proration: "none" as const, undo };
    expect(publicPush(sync)).not.toHaveProperty("undo");
    const meta = priceOverrideAudit({
      dto: { monthly: 80 },
      effective: "next_cycle",
      before: { monthly: 100, annual: 1000, source: "override" },
      after: { monthly: 80, annual: 800, source: "override" },
      sync,
    });
    expect(meta).toEqual({
      kind: "price_override",
      monthly: 80,
      annual: null,
      effective: "next_cycle",
      oldPrice: { monthly: 100, annual: 1000, source: "override" },
      newPrice: { monthly: 80, annual: 800, source: "override" },
      sync: { synced: true, oldAmount: 100, newAmount: 80, proration: "none" },
    });
  });
});
