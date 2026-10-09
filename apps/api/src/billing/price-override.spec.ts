import {
  isPricePushFailure,
  mergeOverride,
  itemUnitAmount,
  priceOverrideAudit,
  priceOverrideIdempotencyKey,
  prorationAllowedFor,
  prorationBehaviorFor,
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
    // Item 8: a live stripeSubId whose Stripe side cannot be repriced REFUSES the change.
    for (const reason of ["no_subscription_item", "no_base_item", "stripe_not_configured"]) {
      expect(isPricePushFailure({ synced: false, reason })).toBe(true);
    }
    expect(isPricePushFailure({ synced: false, reason: "price_unresolvable" })).toBe(false);
    expect(isPricePushFailure({ synced: true })).toBe(false);
  });

  it("builds a deterministic idempotency key from tenant, cents, mode, version and item price", () => {
    const base = {
      tenantId: "t1",
      amountCents: 1999,
      proration: "none" as const,
      version: new Date(5000),
      itemPriceId: "price_1",
    };
    expect(priceOverrideIdempotencyKey(base)).toBe("t1:price-override:1999:none:v5000:price_1");
    expect(priceOverrideIdempotencyKey({ ...base })).toBe(priceOverrideIdempotencyKey(base));
    const others = [
      { ...base, amountCents: 2000 },
      { ...base, proration: "create_prorations" as const },
      { ...base, version: new Date(6000) },
      { ...base, itemPriceId: "price_2" },
      { ...base, tenantId: "t2" },
    ].map(priceOverrideIdempotencyKey);
    expect(new Set([priceOverrideIdempotencyKey(base), ...others]).size).toBe(6);
    expect(priceOverrideIdempotencyKey({ tenantId: "t1", amountCents: 1, proration: "none" })).toBe(
      "t1:price-override:1:none:v0:-",
    );
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

  it("itemUnitAmount reads one item's cents from a subscription, or undefined", () => {
    const sub = { items: { data: [{ id: "si_1", price: { unit_amount: 1999 } }, { id: "si_2" }] } };
    expect(itemUnitAmount(sub, "si_1")).toBe(1999);
    expect(itemUnitAmount(sub, "si_2")).toBeUndefined();
    expect(itemUnitAmount(sub, "si_9")).toBeUndefined();
    expect(itemUnitAmount(null, "si_1")).toBeUndefined();
  });

  it("the audit meta carries the request, effective mode, OLD and NEW price and the push", () => {
    const sync = { synced: true, oldAmount: 100, newAmount: 80, proration: "none" as const };
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
