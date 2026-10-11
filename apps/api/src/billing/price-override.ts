/**
 * #2223 / SA-444, SA-444a: a negotiated fee (`priceOverrideMonthly`) is what the tenant pays, and a
 * ranked plan change never moves it — the plan key (entitlements) changes, the price does not. So on
 * an override row: the quote is 0 with this note, `basePriceSnapshot` stays the fee (the invariant:
 * basePriceSnapshot = what the tenant actually pays; MrrService prices from it), the MRR delta is 0,
 * and `priceOverrideMonthly` is never cleared or rewritten. An explicit fee change in Pricing keeps
 * its own path (updateTenantPriceOverride → reconcilePriceLedger).
 */
export const CUSTOM_FEE_UNCHANGED = "custom fee unchanged — adjust it in Pricing";

/** The row's negotiated monthly fee, or null when it pays the catalog price. */
export function priceOverrideOf(
  sub: { priceOverrideMonthly?: unknown } | null | undefined,
): number | null {
  return sub?.priceOverrideMonthly != null ? Number(sub.priceOverrideMonthly) : null;
}

// ─── SA-733 D8: a super-admin price change reaches Stripe first, with an explicit proration mode ───

/** When a price override takes effect on a live Stripe subscription. Omitted = `next_cycle` (fail-safe). */
export const PRICE_OVERRIDE_EFFECTIVE = ["next_cycle", "now_prorated"] as const;
export type PriceOverrideEffective = (typeof PRICE_OVERRIDE_EFFECTIVE)[number];
export type StripeProrationBehavior = "none" | "create_prorations";

/** The override columns an admin request would leave on the row (null = cleared). */
export interface ProposedOverride {
  monthly: number | null;
  annual: number | null;
}

/** Options for pushing a resolved price onto a live Stripe subscription. */
export interface PricePushOptions {
  /** Defaults to `next_cycle` (proration `none`). */
  effective?: PriceOverrideEffective;
  /** The override state to price from instead of the row's (Stripe-first: the row is not written yet). */
  proposed?: ProposedOverride;
  /** The override row's `updatedAt` BEFORE the change — makes the idempotency key version-specific. */
  version?: Date | string | null;
}

export interface PricePushResult {
  synced: boolean;
  reason?: string;
  oldAmount?: number;
  newAmount?: number;
  /** The proration mode actually sent (may be `none` although `now_prorated` was asked — see below). */
  proration?: StripeProrationBehavior;
  /** The item already billed this amount, so Stripe was not called. */
  unchanged?: boolean;
}

export function prorationBehaviorFor(effective: PriceOverrideEffective): StripeProrationBehavior {
  return effective === "now_prorated" ? "create_prorations" : "none";
}

/**
 * Only an `active` subscription takes a mid-period proration. past_due / unpaid pile credit or charge onto an
 * invoice nobody is paying, and a `trialing` one has no paid period to prorate against (lead ruling R2: an
 * upgrade during a trial charges nothing). Those get proration `none`.
 */
export function prorationAllowedFor(status: string): boolean {
  return status === "active";
}

/** Skip reasons that mean "nothing live to update" — the local write may proceed. Everything else
 *  that is `synced:false` and not in this set is a Stripe failure and must stop a Stripe-first write. */
export const PRICE_PUSH_FAILURE_REASONS: readonly string[] = [
  "stripe_retrieve_failed",
  "stripe_product_create_failed",
  "stripe_update_failed",
  // A live stripeSubId whose Stripe side cannot be repriced (no base item, or Stripe unconfigured) must
  // REFUSE the change: writing the fee locally would leave Stripe billing the old price. Manual-pay
  // tenants have no stripeSubId and never get here.
  "no_subscription_item",
  "no_base_item",
  "stripe_not_configured",
];

export function isPricePushFailure(result: { synced: boolean; reason?: string }): boolean {
  return !result.synced && PRICE_PUSH_FAILURE_REASONS.includes(result.reason ?? "");
}

/**
 * Deterministic Stripe idempotency key for one price push: (tenant, "price-override", the new amount in
 * cents, the proration SENT, the override row version) plus the item's CURRENT Stripe price id. A retry of the
 * same change sends the same key; a later, different change differs in amount or version. The price id
 * (inline `price_data` mints a new Price on every update) keeps a retry that follows a corrective re-sync
 * from being swallowed as a replay of the first, since the revert changed the item's price.
 */
export function priceOverrideIdempotencyKey(parts: {
  tenantId: string;
  amountCents: number;
  proration: StripeProrationBehavior;
  version?: Date | string | null;
  itemPriceId?: string | null;
  /** A per-ATTEMPT nonce: Stripe replays a cached 5xx for 24 h under a repeated key, so a retry must differ. */
  attempt?: string;
}): string {
  const version =
    parts.version == null ? "v0" : `v${new Date(parts.version as string | Date).getTime()}`;
  return [
    parts.tenantId,
    "price-override",
    parts.amountCents,
    parts.proration,
    version,
    parts.itemPriceId ?? "-",
    ...(parts.attempt ? [parts.attempt] : []),
  ].join(":");
}

/** The override state a request leaves behind: `undefined` keeps the column, `null` clears it. */
export function mergeOverride(
  existing: { priceOverrideMonthly?: unknown; priceOverrideAnnual?: unknown } | null | undefined,
  dto: { monthly?: number | null; annual?: number | null },
): ProposedOverride {
  const current = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    monthly: dto.monthly === undefined ? current(existing?.priceOverrideMonthly) : dto.monthly,
    annual: dto.annual === undefined ? current(existing?.priceOverrideAnnual) : dto.annual,
  };
}

/** True when two override reads (a Decimal row vs a number) hold the same fee. */
export function sameOverride(
  a: { priceOverrideMonthly?: unknown; priceOverrideAnnual?: unknown } | null | undefined,
  b: { priceOverrideMonthly?: unknown; priceOverrideAnnual?: unknown } | null | undefined,
): boolean {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return (
    n(a?.priceOverrideMonthly) === n(b?.priceOverrideMonthly) &&
    n(a?.priceOverrideAnnual) === n(b?.priceOverrideAnnual)
  );
}

/** The unit amount (cents) Stripe reports for one subscription item, or undefined when unreadable. */
export function itemUnitAmount(stripeSub: any, itemId: string): number | undefined {
  const item = stripeSub?.items?.data?.find((i: any) => i?.id === itemId);
  return typeof item?.price?.unit_amount === "number" ? item.price.unit_amount : undefined;
}

/**
 * The audit meta of one price-override change: the request (`monthly`/`annual`), the effective mode asked
 * for, the OLD and NEW resolved price, and what the Stripe push did. Actor and timestamp are the audit
 * row's own `userId` / `createdAt`.
 */
export function priceOverrideAudit(args: {
  dto: { monthly?: number | null; annual?: number | null };
  effective: PriceOverrideEffective;
  before: { monthly: number; annual: number; source: string } | null;
  after: { monthly: number; annual: number; source: string };
  sync: PricePushResult;
}): Record<string, unknown> {
  const price = (p: { monthly: number; annual: number; source: string } | null) =>
    p ? { monthly: p.monthly, annual: p.annual, source: p.source } : null;
  return {
    kind: "price_override",
    monthly: args.dto.monthly ?? null,
    annual: args.dto.annual ?? null,
    effective: args.effective,
    oldPrice: price(args.before),
    newPrice: price(args.after),
    sync: args.sync,
  };
}
