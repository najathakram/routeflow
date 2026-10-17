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

/**
 * MF4. A COMPLETED catch-up session whose subscription is not the stored one is held until the ordinary completion
 * has DECIDED against it. Stripe retries a failed webhook for up to 3 days, so "it has not arrived yet" is not "it
 * will never apply". This many days past the session's expiry with no decision, the operator gets ONE structured
 * alert (log + a platform-admin notice). Internal only: never a tenant email.
 */
export const CATCHUP_LATE_ALERT_DAYS = 3;

/** Stripe retries a failed webhook delivery for up to this many days. */
export const STRIPE_WEBHOOK_RETRY_DAYS = 3;

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
  /** The invoice's display number and currency: the paused-still-owed notice names them. */
  invoiceNumber?: string | null;
  currency?: string | null;
  /** The billed period's month ("October 2026", UTC) from the first invoice line, for the never-attempted d0 copy. */
  periodLabel?: string | null;
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

/**
 * The 409 for staff MANUALLY ACTIVATING a tenant whose claim is held (MF3). Every held state refuses: even while the
 * session is only OPEN the customer can still pay it AFTER staff recorded the same October by activating, and they
 * are charged twice. SESSION_OPEN has its own code (the admin copy says "wait for it to complete or expire"); the
 * later states are the same "pending" refusal as everywhere else. Null = no claim.
 */
export function activationClaimRefusal(state: string | null | undefined): ConflictException | null {
  if (state === "SESSION_OPEN") {
    return new ConflictException({
      code: API_ERROR_CODES.ACTIVATION_CATCHUP_SESSION_OPEN,
      message:
        "A card checkout is open for this tenant (October catch-up). Activating them now could charge them " +
        "twice. Wait for it to complete or expire, then try again.",
    });
  }
  return claimRefusal(state);
}

/** The two values of the `catchup` marker: `period` (trial_one_time) and `prepaid` (the stub-free trial). */
export const CATCHUP_KINDS = ["period", "prepaid"] as const;

/** What the catch-up checkout stamps on the Stripe session / subscription so the webhook can act on it. */
export const CATCHUP_META = {
  /**
   * One of CATCHUP_KINDS: "period" (trial_one_time - a one-time line covers [from, to)) or "prepaid" (the stub-free
   * `trial` shape - nothing is owed for the period before the trial end).
   */
  catchup: "catchup",
  shape: "catchup_shape",
  stubCents: "catchup_stub_cents",
  stubLabel: "catchup_stub_label",
  finalizeAt: "catchup_finalize_at",
  /** trial_one_time: the span the one-time line covers [from, to) - ISO instants. */
  from: "catchup_from",
  to: "catchup_to",
  /** A line under Stripe's $0.50 minimum was forgiven (the session carries none): its cents, for the audit row. */
  forgivenCents: "catchup_forgiven_cents",
  /**
   * Row 542d / SA-800c: sha256 hex of the FULL session terms (everything Stripe charges or bills: the lines, the
   * trial end, the mode, the plan key...), computed by `catchupTermsSignature` over the params exactly as
   * `buildCatchupSessionParams` builds them (the constant `managed_payments` policy is added AFTER signing, by
   * `withCheckoutPolicy`). The reuse check recomputes it from the fresh plan; a stored session with another value is
   * stale, one with none is stale too (SA-800d), and a malformed one is unknown.
   */
  termsSig: "catchup_terms_sig",
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
