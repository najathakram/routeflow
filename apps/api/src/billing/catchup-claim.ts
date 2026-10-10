import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-733r3 [N2] / r4 N2: the October CATCH-UP CLAIM. While a manual tenant's catch-up checkout is in flight the
 * RouteFlow-side invoicing for it is frozen (a payment recorded on its OPEN RfInvoice, a reopen, the issuer), so
 * the customer can never be charged twice - once by Stripe and once through a manual RfInvoice.
 *
 *   SESSION_OPEN            written under the Tenant lock BEFORE any Stripe call; the Checkout session is open.
 *   AWAITING_FIRST_PAYMENT  the session completed; the claim lasts until the settling invoice is PAID (void the
 *                           RfInvoice(s), clear) or DEFINITIVELY FAILS (release).
 *   RELEASING               a release is under way (step 1 of r4 N2(b)); the hourly sweep finishes it.
 *
 * The strings are pinned equal to the DB CHECK "TenantSubscription_catchupState_chk" by catchup-claim.spec.ts
 * (L-072: a hand-typed mirror of a constraint is how drift ships).
 */
export const CATCHUP_STATES = ["SESSION_OPEN", "AWAITING_FIRST_PAYMENT", "RELEASING"] as const;
export type CatchupState = (typeof CATCHUP_STATES)[number];

export const isCatchupState = (v: unknown): v is CatchupState =>
  typeof v === "string" && (CATCHUP_STATES as readonly string[]).includes(v);

/** A claim whose session id was never stored is an orphan after this long (a session lives at most 24 h). */
export const CATCHUP_ORPHAN_AFTER_MS = 25 * 60 * 60 * 1000;

/** The Stripe-side facts a claim is judged from. */
export interface InvoiceFacts {
  status: string | null;
  amountPaid: number;
  amountDue: number;
  paymentProcessing: boolean;
  nextPaymentAttempt: number | null;
  attemptCount: number;
  subscriptionId: string | null;
  /** What is still owed, in cents (`amount_remaining`); absent on a fixture that predates SA-733r7 PR-B3. */
  amountRemaining?: number;
  /** Stripe's hosted payment page for the invoice; the 409 PAYMENT_OVERDUE body carries it. */
  hostedInvoiceUrl?: string | null;
}

/** An invoice is settled when Stripe says paid. */
export const invoiceIsPaid = (f: InvoiceFacts): boolean => f.status === "paid";

/**
 * "Definitively failed" (r3 N2): Stripe has given up on it - uncollectible/void, or open with at least one
 * attempt behind it and no further attempt scheduled. A payment still `processing` (ACH) is never a failure.
 */
export function invoiceDefinitivelyFailed(f: InvoiceFacts): boolean {
  if (f.paymentProcessing) return false;
  if (f.status === "uncollectible" || f.status === "void") return true;
  return f.status === "open" && f.attemptCount > 0 && f.nextPaymentAttempt == null;
}

/**
 * The 409 for staff recording a payment / reopening / issuing on a tenant whose claim is held. SESSION_OPEN is the
 * "session is open" refusal (M5); the later states are "pending" (r2). Null = no claim.
 */
export function claimRefusal(state: string | null | undefined): ConflictException | null {
  if (!state) return null;
  if (state === "SESSION_OPEN") {
    return new ConflictException({
      code: API_ERROR_CODES.CATCHUP_SESSION_OPEN,
      message:
        "A card checkout is open for this tenant (October catch-up). Recording a payment now could charge " +
        "them twice. Wait for it to complete or expire, then try again.",
    });
  }
  return new ConflictException({
    code: API_ERROR_CODES.CATCHUP_PENDING,
    message:
      "This tenant's card subscription is waiting for its first payment (October catch-up). RouteFlow " +
      "invoices are on hold until it clears or fails.",
  });
}

/** The two values of the `catchup` marker: `period` (trial_one_time) and `prepaid` (trial / anchor_no_line). */
export const CATCHUP_KINDS = ["period", "prepaid"] as const;

/** What the catch-up checkout stamps on the Stripe session / subscription so the webhook can act on it. */
export const CATCHUP_META = {
  /** "2026-10" (the month the stub starts in) or "prepaid" (the trial branch). */
  catchup: "catchup",
  shape: "catchup_shape",
  stubCents: "catchup_stub_cents",
  stubLabel: "catchup_stub_label",
  finalizeAt: "catchup_finalize_at",
  /** trial_one_time: the span the one-time line covers [from, to) - ISO instants. */
  from: "catchup_from",
  to: "catchup_to",
} as const;

/**
 * SA-733r5: the ONE predicate every trial-aware path reads - "is this Stripe object a catch-up?" - for a Checkout
 * session and for the subscription it created (the marker rides both). A Stripe `trialing` catch-up subscription is
 * an ACTIVE tenant: it is never mapped to TRIAL, its `trial_will_end` is ignored, the trial sweeps and banners
 * (all keyed on Tenant.status = TRIAL) never see it, and extendTrial refuses it.
 */
export const isCatchupSubscription = (
  obj: { metadata?: Record<string, string> | null } | null | undefined,
): boolean =>
  typeof obj?.metadata?.[CATCHUP_META.catchup] === "string" &&
  (CATCHUP_KINDS as readonly string[]).includes(obj.metadata![CATCHUP_META.catchup]);

/** A catch-up Checkout session (same marker, same predicate; the sweep passes a synthetic "sweep" marker). */
export const isCatchupSession = (session: { metadata?: Record<string, string> | null }): boolean =>
  typeof session?.metadata?.[CATCHUP_META.catchup] === "string" &&
  session.metadata![CATCHUP_META.catchup].length > 0;
