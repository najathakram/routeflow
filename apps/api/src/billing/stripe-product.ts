/**
 * W-810 / SA-931: ONE Stripe Product per plan code and per add-on SKU, with a deterministic id
 * (`rf_plan_<code>` / `rf_addon_<sku>`). Every recurring `price_data` in billing points at one of these.
 *
 * Why: Checkout's inline `product_data` mints a product that Stripe creates INACTIVE and cannot reactivate, so a
 * later price push on a Checkout-born subscription (`price_data.product` = that product) fails, and the
 * redelivery storm that follows never clears. A product we own is active, shared, and reactivated when found
 * inactive. The one exception is the catch-up's one-time stub line, which has no recurring price to push.
 */
import { planDisplayName } from "@routeflow/pricing";

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
 * The active product for (kind, key): retrieved if it exists (reactivated if inactive), created with the deterministic id
 * otherwise. Idempotent and safe under a concurrent create. A found product's name is rewritten only when the caller
 * passes `reconcileName` (SA-1547 Q3: plan products, whose name is keyed on the plan key alone); one compare, then
 * at most one update, so a second ensure makes no call and names cannot flap.
 * Throws the Stripe error as-is; callers map it to their own failure reason.
 */
export async function ensureStripeProduct(
  client: StripeProductsClient,
  kind: StripeProductKind,
  key: string,
  opts: { name: string; metadata?: Record<string, string>; reconcileName?: string },
): Promise<string> {
  const id = stripeProductId(kind, key);
  const found = await retrieveOrNull(client, id);
  if (found) return reconcile(client, id, found, opts.reconcileName);
  try {
    // W-1464 R-282 M2: catalog only - a product carries no price or charge, so it stays outside the live-payments wall.
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
    return reconcile(client, id, raced, opts.reconcileName);
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
  found: { active?: boolean; name?: string },
  reconcileName?: string,
): Promise<string> {
  const patch: Record<string, unknown> = {};
  if (found.active === false) patch.active = true;
  // SA-1547 Q3: a plan product still named the old way ("RouteFlow Essentials") is renamed on its next use. Name only:
  // no price, no subscription item.
  if (reconcileName !== undefined && found.name !== reconcileName) patch.name = reconcileName;
  // W-1464 R-282 M2: catalog only - editing a product's name or flags charges nothing, so it stays unwalled.
  if (Object.keys(patch).length) await client.products.update(id, patch);
  return id;
}

/** The tag a checkout add-on line's product carries so a completion can tell an add-on item from the base plan. */
export const ADDON_SKU_METADATA_KEY = "addonSku";

/**
 * The shared plan product (`rf_plan_<code>`), named by the plan key alone (SA-1547 Q3, owner: plan name only):
 * `planDisplayName(planKey)` ("Essentials" for CORE), the name the business already sees in the app. A found product
 * with that key is renamed to it once. `createName` (a definition's name) is used only to CREATE a product for a key
 * `planDisplayName` does not name; such a product is never renamed, and the raw key is never a name.
 */
export async function ensurePlanProduct(
  client: StripeProductsClient,
  planKey: string,
  createName?: string,
): Promise<string> {
  const named = planDisplayName(planKey);
  // A caller's own fallback can still pass the raw key for an unnamed key with no catalog name (open owner question:
  // refusing it would break the restore paths that fall back to sub.planKey); see the PR body.
  const name = named ?? createName?.trim();
  if (!name)
    throw new Error(
      `ensurePlanProduct: no display name for plan ${planKey}; not creating its product`,
    );
  return ensureStripeProduct(client, "plan", planKey, {
    name,
    ...(named ? { reconcileName: named } : {}),
  });
}

/**
 * The shared add-on product (`rf_addon_<sku>`), tagged with its SKU, named "<name> add-on" (SA-1547 Q3, no dash). The
 * name is set on CREATE only: callers pass names from two sources (the business's own plan version, and the newest
 * published row on a revert), which can differ, so a reconcile here could flap. Existing add-on products keep theirs.
 */
export function ensureAddonProduct(
  client: StripeProductsClient,
  sku: string,
  name: string,
): Promise<string> {
  return ensureStripeProduct(client, "addon", sku, {
    name: `${name} add-on`,
    metadata: { [ADDON_SKU_METADATA_KEY]: sku },
  });
}
