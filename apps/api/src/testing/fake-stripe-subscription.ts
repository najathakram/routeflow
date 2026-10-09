/**
 * A STATEFUL fake of the slice of StripeService a plan change touches (SA-733r M7). It applies each
 * `subscriptions.update` to its own item list — a new `price_data` replaces an item's price, `deleted` removes
 * it, an item without an id is created — so a spec can assert the END state ("Stripe == the database") instead
 * of only the call shapes. No network: nothing here can reach a live Stripe.
 */
export interface FakeStripeItem {
  id: string;
  quantity?: number;
  metadata?: Record<string, string>;
  price: Record<string, any>;
  /** Stripe's item-level billing period (epoch seconds) when a spec needs one. */
  current_period_start?: number;
  current_period_end?: number;
}

export function fakeStripeSubscription(items: FakeStripeItem[], status = "active") {
  const state = { status, items: items.map((i) => structuredClone(i)), created: 0 };
  const snapshot = () => ({ id: "sub_1", status: state.status, items: { data: state.items } });
  const stripe = {
    state,
    isConfigured: true,
    getSubscription: jest.fn(async (..._a: unknown[]) => snapshot()),
    updateSubscription: jest.fn(
      async (_id: string, params: any, _opts: { idempotencyKey: string }) => {
        for (const it of params.items ?? []) {
          if (it.deleted) {
            state.items = state.items.filter((x) => x.id !== it.id);
          } else if (it.id) {
            const target = state.items.find((x) => x.id === it.id);
            if (target && it.price_data) target.price = { ...it.price_data };
          } else {
            state.items.push({
              id: `si_new_${++state.created}`,
              quantity: it.quantity,
              metadata: it.metadata,
              price: { ...it.price_data },
            });
          }
        }
        return snapshot();
      },
    ),
    client: { products: { create: jest.fn(async () => ({ id: "prod_scale" })) } },
    /** The base item's current unit amount in cents, as Stripe would bill it. */
    amountOf: (id: string) => state.items.find((x) => x.id === id)?.price.unit_amount,
  };
  return stripe;
}
