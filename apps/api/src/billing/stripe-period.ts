/**
 * #2436 (P0): the Stripe API version every client pins. SDK 22.6.2's default is this same
 * `2026-08-26.dahlia`; pinning it explicitly means an SDK bump can never silently move the shape
 * the handlers read (stripe-period.spec.ts pins it equal to the SDK's own ApiVersion).
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

const epoch = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * A subscription's current billing period. Under dahlia `current_period_start/end` live on the
 * subscription ITEMS (SubscriptionItems.d.ts:54-58); a webhook payload follows the ENDPOINT's API
 * version, so an older-shaped top-level field is the fallback. Null when neither yields a real
 * epoch — callers then write no period at all, never `new Date(NaN)` (Prisma rejects it, which
 * 500'd checkout.session.completed and left stripeSubId unstored).
 *
 * #2440 N2: the period is read from the base-plan item (stripeBaseItem).
 */
export function stripeSubscriptionPeriod(
  sub: any,
  addonItemIds: ReadonlySet<string> = new Set(),
): { periodStart: Date; periodEnd: Date } | null {
  const item = stripeBaseItem(sub, addonItemIds);
  const start = epoch(item?.current_period_start) ?? epoch(sub?.current_period_start);
  const end = epoch(item?.current_period_end) ?? epoch(sub?.current_period_end);
  if (start == null || end == null) return null;
  return { periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000) };
}

/**
 * #2440: a subscription's BASE-PLAN item — the first item that is not one of the tenant's known
 * add-on items (`addonItemIds`, from TenantAddon.stripeItemId); the first item when every item is
 * a known add-on; undefined when there are none. Stripe does not order items base-first, so
 * `items.data[0]` can be an add-on.
 */
export function stripeBaseItem(sub: any, addonItemIds: ReadonlySet<string> = new Set()): any {
  const items: any[] = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  return items.find((i) => !addonItemIds.has(i?.id)) ?? items[0];
}

/**
 * ONE definition of a "live" Stripe subscription, shared by every guard that must not create or accept a
 * second one: it still bills (or will keep trying to). `incomplete` (never paid), `incomplete_expired`,
 * `canceled` and anything unknown are NOT live.
 *
 * `paused` is NOT live ON PURPOSE (SA ruling): a paused subscription collects nothing until someone resumes
 * it, so a fresh checkout for the tenant is a legitimate way forward rather than a second bill. The cost of
 * that call is a paused subscription left behind when the new one is applied — tracked separately (B1155),
 * not solved by widening this predicate: every guard that shares it would then refuse a tenant whose old
 * subscription is paused.
 */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);
export const isLiveStripeSubscriptionStatus = (status: unknown): boolean =>
  typeof status === "string" && LIVE_SUBSCRIPTION_STATUSES.has(status);

/** A Stripe expandable reference (`"id"` or an expanded `{ id }`) as its id, else null. */
export function stripeRefId(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  const id = (v as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : null;
}

/**
 * #2440: the subscription an invoice belongs to. Under dahlia it lives at
 * `parent.subscription_details.subscription`; an older endpoint version sends the top-level
 * `subscription`. null = not a subscription invoice (a one-off, or a free pilot's).
 */
export function stripeInvoiceSubscriptionId(invoice: any): string | null {
  return (
    stripeRefId(invoice?.parent?.subscription_details?.subscription) ??
    stripeRefId(invoice?.subscription)
  );
}
