/**
 * SA-736r (R17-2): `couponFull` means "the subscription's next recurring invoice is $0 because of
 * discounts" - a 100% coupon, `amount_off >= price`, or item-level discounts that zero every item. It is
 * COMPUTED BY STRIPE, not by us: the sync reads the upcoming-invoice preview and applies the predicate below.
 * Pure: no Stripe client, no database. The writer is `coupon-state.ts`.
 */

/**
 * Stripe `expand` for the sync's subscription retrieve (API `2026-08-26.dahlia`). Under dahlia the
 * subscription carries `discounts: Array<string | Discount>`; `expand[]=discounts` expands each one (stripe@22
 * `Subscriptions.d.ts`: "Use `expand[]=discounts` to expand each discount"). Each Discount carries
 * `source.coupon` (an id or a Coupon), `end` (epoch seconds, repeating coupons) and `start`. The coupon id is
 * informational (`couponId`); whether the tenant is billed is decided from the preview, never from the coupon.
 */
export const COUPON_SYNC_EXPAND = ["discounts"] as const;

/**
 * Per-request options for BOTH Stripe calls of a sync: capped well inside the 5-minute webhook claim lease
 * and never retried by the SDK (a timeout throws, so the ledger records an error and Stripe redelivers).
 * Mirrors `PAYMENT_FAILED_PORTAL_REQUEST` in billing.service.ts.
 */
export const COUPON_SYNC_REQUEST = { timeoutMs: 10_000, maxNetworkRetries: 0 } as const;

/** The state the three columns hold. `full` alone decides billing; the rest is informational. */
export interface CouponState {
  full: boolean;
  couponId: string | null;
  endsAt: Date | null;
}

/** Nothing applies: every column at its reset value. */
export const NO_COUPON: CouponState = { full: false, couponId: null, endsAt: null };

const sumAmounts = (list: unknown): number =>
  Array.isArray(list)
    ? list.reduce(
        (s: number, d: { amount?: unknown }) => s + (typeof d?.amount === "number" ? d.amount : 0),
        0,
      )
    : 0;

/** A subscription line of an upcoming-invoice preview that is NOT a proration. */
function isRecurringSubscriptionLine(line: any): boolean {
  const parent = line?.parent;
  const isSubscriptionLine =
    parent?.type === "subscription_item_details" || line?.type === "subscription";
  if (!isSubscriptionLine) return false;
  const proration = parent?.subscription_item_details?.proration ?? line?.proration ?? false;
  return proration !== true;
}

/**
 * The predicate (SA-736r, final text fixes #1). `couponFull` is true iff the preview has:
 *   - at least one non-proration subscription line;
 *   - sum(total_discount_amounts) > 0;
 *   - EVERY non-proration subscription line with `amount - sum(its discount_amounts) <= 0`.
 * It NEVER reads `amount_due`, `total` or the customer balance: credit grants and negative prorations lower
 * the total, and a 50% coupon plus a credit must not read as full.
 *
 * Fail-closed on a truncated preview (`lines.has_more`): unseen lines could still bill, so it is NOT full -
 * a wrongly "paying" tenant is visible revenue, a wrongly "unbilled" one is hidden.
 */
export function couponFullFromPreview(preview: any): boolean {
  if (!preview || preview.lines?.has_more === true) return false;
  const lines: any[] = Array.isArray(preview.lines?.data) ? preview.lines.data : [];
  const recurring = lines.filter(isRecurringSubscriptionLine);
  if (recurring.length === 0) return false;
  if (!(sumAmounts(preview.total_discount_amounts) > 0)) return false;
  return recurring.every((l) => {
    const amount = typeof l.amount === "number" ? l.amount : Number.NaN;
    return amount - sumAmounts(l.discount_amounts) <= 0;
  });
}

/** The first discount's coupon id and (repeating coupons) end date, from a retrieved subscription. */
export function firstCouponOfSubscription(sub: any): {
  couponId: string | null;
  endsAt: Date | null;
} {
  const discounts: unknown[] = Array.isArray(sub?.discounts) ? sub.discounts : [];
  const first = discounts.find((d) => d && typeof d === "object") as any;
  if (!first) return { couponId: null, endsAt: null };
  const coupon = first.source?.coupon ?? first.coupon;
  const couponId =
    typeof coupon === "string" && coupon
      ? coupon
      : typeof coupon?.id === "string"
        ? coupon.id
        : null;
  const end = typeof first.end === "number" && Number.isFinite(first.end) ? first.end : null;
  return { couponId, endsAt: end == null ? null : new Date(end * 1000) };
}

/** Stripe's "this subscription has no upcoming invoice" error (ending or canceled): the stored value stays. */
export function isInvoiceUpcomingNone(err: unknown): boolean {
  return (err as { code?: string } | null | undefined)?.code === "invoice_upcoming_none";
}
