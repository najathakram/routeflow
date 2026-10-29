/**
 * W-810 / SA-931: ONE Stripe Product per plan code and per add-on SKU, with a deterministic id
 * (`rf_plan_<code>` / `rf_addon_<sku>`). Every recurring `price_data` in billing points at one of these.
 *
 * Why: Checkout's inline `product_data` mints a product that Stripe creates INACTIVE and cannot reactivate, so a
 * later price push on a Checkout-born subscription (`price_data.product` = that product) fails, and the
 * redelivery storm that follows never clears. A product we own is active, shared, and reactivated when found
 * inactive. The one exception is the catch-up's one-time stub line, which has no recurring price to push.
 */
export type StripeProductKind = "plan" | "addon";

/** The slice of the Stripe client this helper touches (the real `stripe.products`). */
export interface StripeProductsClient {
  products: {
    retrieve(id: string): Promise<{ id: string; active?: boolean; name?: string }>;
    update(id: string, params: Record<string, unknown>): Promise<{ id: string }>;
    create(params: Record<string, unknown>): Promise<{ id: string }>;
  };
}

export function stripeProductId(kind: StripeProductKind, key: string): string {
  const slug = String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  if (!slug) throw new Error(`ensureStripeProduct: empty ${kind} key`);
  return `rf_${kind}_${slug}`;
}

const statusOf = (err: unknown): number | undefined => (err as { statusCode?: number })?.statusCode;
const codeOf = (err: unknown): string | undefined => (err as { code?: string })?.code;

/**
 * The active product for (kind, key): retrieved if it exists (reactivated if inactive; its name is cosmetic and never rewritten), created with the deterministic id otherwise. Idempotent and safe under a concurrent create.
 * Throws the Stripe error as-is; callers map it to their own failure reason.
 */
export async function ensureStripeProduct(
  client: StripeProductsClient,
  kind: StripeProductKind,
  key: string,
  opts: { name: string; metadata?: Record<string, string> },
): Promise<string> {
  const id = stripeProductId(kind, key);
  const found = await retrieveOrNull(client, id);
  if (found) return reconcile(client, id, found);
  try {
    await client.products.create({
      id,
      name: opts.name,
      active: true,
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
    return id;
  } catch (err) {
    if (codeOf(err) !== "resource_already_exists") throw err;
    // Another replica created it between our retrieve and create.
    const raced = await retrieveOrNull(client, id);
    if (!raced) throw err;
    return reconcile(client, id, raced);
  }
}

async function retrieveOrNull(client: StripeProductsClient, id: string) {
  try {
    return await client.products.retrieve(id);
  } catch (err) {
    if (statusOf(err) === 404 || codeOf(err) === "resource_missing") return null;
    throw err;
  }
}

async function reconcile(
  client: StripeProductsClient,
  id: string,
  found: { active?: boolean },
): Promise<string> {
  const patch: Record<string, unknown> = {};
  if (found.active === false) patch.active = true;
  if (Object.keys(patch).length) await client.products.update(id, patch);
  return id;
}

/** The tag a checkout add-on line's product carries so a completion can tell an add-on item from the base plan. */
export const ADDON_SKU_METADATA_KEY = "addonSku";

/** The shared plan product (`rf_plan_<code>`), named "RouteFlow <plan name>". */
export function ensurePlanProduct(
  client: StripeProductsClient,
  planKey: string,
  planName: string,
): Promise<string> {
  return ensureStripeProduct(client, "plan", planKey, { name: `RouteFlow ${planName}` });
}

/** The shared add-on product (`rf_addon_<sku>`), tagged with its SKU. */
export function ensureAddonProduct(
  client: StripeProductsClient,
  sku: string,
  name: string,
): Promise<string> {
  return ensureStripeProduct(client, "addon", sku, {
    name: `RouteFlow add-on — ${name}`,
    metadata: { [ADDON_SKU_METADATA_KEY]: sku },
  });
}
