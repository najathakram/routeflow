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

/** What a push changed on Stripe — enough to put it back if the local write then fails. */
export interface PriceUndo {
  subscriptionId: string;
  itemId: string;
  productId: string;
  interval: "month" | "year";
  /** The item's amount before the push, in whole cents. */
  previousCents: number;
  proration: StripeProrationBehavior;
  /** The idempotency key of the push this undoes (the revert key derives from it). */
  key: string;
}

export interface PricePushResult {
  synced: boolean;
  reason?: string;
  oldAmount?: number;
  newAmount?: number;
  /** The proration mode actually sent (may be `none` although `now_prorated` was asked — see below). */
  proration?: StripeProrationBehavior;
  undo?: PriceUndo;
}

export function prorationBehaviorFor(effective: PriceOverrideEffective): StripeProrationBehavior {
  return effective === "now_prorated" ? "create_prorations" : "none";
}

/**
 * Stripe statuses whose NEXT invoice a price change can still reach. past_due / unpaid are included
 * (SA-733r M7): a paused or delinquent tenant that is later reinstated must be billed the price the
 * owner set, so an owner cut on a paused tenant is not silently dropped. canceled, incomplete and
 * incomplete_expired are not live subscriptions — they stay skipped (as does a Stripe-side `paused`).
 */
export const STRIPE_PRICE_PUSH_STATUSES: readonly string[] = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
];

/** Statuses where a mid-period proration would pile credit/charge onto an invoice nobody is paying. */
export function prorationAllowedFor(status: string): boolean {
  return status === "active" || status === "trialing";
}

/** Skip reasons that mean "nothing live to update" — the local write may proceed. Everything else
 *  that is `synced:false` and not in this set is a Stripe failure and must stop a Stripe-first write. */
export const PRICE_PUSH_FAILURE_REASONS: readonly string[] = [
  "stripe_retrieve_failed",
  "stripe_product_create_failed",
  "stripe_update_failed",
];

export function isPricePushFailure(result: { synced: boolean; reason?: string }): boolean {
  return !result.synced && PRICE_PUSH_FAILURE_REASONS.includes(result.reason ?? "");
}

/**
 * Deterministic Stripe idempotency key for one price push: (tenant, "price-override", the new amount in
 * cents, effective, the override row's version) plus the item's CURRENT Stripe price id. A retry of the
 * same change sends the same key; a later, different change differs in amount or version. The price id
 * (inline `price_data` mints a new Price on every update) keeps a retry that follows a compensating revert
 * from being swallowed as a replay of the first, since the revert changed the item's price.
 */
export function priceOverrideIdempotencyKey(parts: {
  tenantId: string;
  amountCents: number;
  effective: PriceOverrideEffective;
  version?: Date | string | null;
  itemPriceId?: string | null;
}): string {
  const version =
    parts.version == null ? "v0" : `v${new Date(parts.version as string | Date).getTime()}`;
  return [
    parts.tenantId,
    "price-override",
    parts.amountCents,
    parts.effective,
    version,
    parts.itemPriceId ?? "-",
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

/** The `subscriptions.update` params that put an item back at the amount it held before a push. */
export function revertPriceParams(undo: PriceUndo): Record<string, unknown> {
  return {
    items: [
      {
        id: undo.itemId,
        price_data: {
          currency: "usd",
          unit_amount: undo.previousCents,
          recurring: { interval: undo.interval },
          product: undo.productId,
        },
      },
    ],
    proration_behavior: undo.proration,
  };
}

/** A push result without its revert handle — what is returned to the admin and written to the audit row. */
export function publicPush(push: PricePushResult): Omit<PricePushResult, "undo"> {
  const { undo: _undo, ...rest } = push;
  return rest;
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
    sync: publicPush(args.sync),
  };
}
