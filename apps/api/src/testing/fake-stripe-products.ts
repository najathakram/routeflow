/**
 * A STATEFUL fake of Stripe's product table (W-810). Real Stripe refuses a `price_data.product` that is
 * inactive, and Checkout's inline `product_data` products are born inactive and cannot be reactivated by
 * us; the fake enforces both so a spec fails on the shape that fails in production. No network.
 */
export interface FakeProduct {
  id: string;
  active: boolean;
  name?: string;
  metadata?: Record<string, string>;
}

export function stripeError(statusCode: number, code: string, message: string) {
  return Object.assign(new Error(message), { statusCode, code, type: "invalid_request_error" });
}

export function fakeStripeProducts(seed: FakeProduct[] = []) {
  const table = new Map<string, FakeProduct>(seed.map((p) => [p.id, structuredClone(p)]));
  let minted = 0;
  const products = {
    retrieve: jest.fn(async (id: string) => {
      const p = table.get(id);
      if (!p) throw stripeError(404, "resource_missing", `No such product: '${id}'`);
      return structuredClone(p);
    }),
    update: jest.fn(async (id: string, params: Record<string, any>) => {
      const p = table.get(id);
      if (!p) throw stripeError(404, "resource_missing", `No such product: '${id}'`);
      Object.assign(p, params);
      return structuredClone(p);
    }),
    create: jest.fn(async (params: Record<string, any>) => {
      const id: string = params.id ?? `prod_fake_${++minted}`;
      if (table.has(id))
        throw stripeError(400, "resource_already_exists", `Product already exists.`);
      const p: FakeProduct = {
        id,
        active: params.active ?? true,
        name: params.name,
        metadata: params.metadata,
      };
      table.set(id, p);
      return structuredClone(p);
    }),
  };
  /** What Stripe does with a `price_data.product` on a subscription (item) write. */
  const assertUsable = (productId: unknown) => {
    if (typeof productId !== "string") return;
    const p = table.get(productId);
    if (!p) throw stripeError(404, "resource_missing", `No such product: '${productId}'`);
    if (!p.active)
      throw stripeError(
        400,
        "parameter_invalid_empty",
        `The product '${productId}' is not active.`,
      );
  };
  return { table, products, assertUsable };
}
