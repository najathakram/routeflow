import { TX_CONFLICT_MAX_ATTEMPTS } from "../common/tx-retry";
import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { CronExpression } from "@nestjs/schedule";
import { LeaderCron } from "../common/cron-lock";
import { withAdvisoryLock, LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import { Prisma, TenantPlan } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { escapeHtml, safeLinkHref } from "../common/html-escape";
import { billingPauseMode, dunningEmailsFor } from "./dunning-config";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { fromCents, roundMoney } from "@routeflow/pricing";
import {
  type PricePushOptions,
  type PricePushResult,
  priceOverrideIdempotencyKey,
  prorationAllowedFor,
  prorationBehaviorFor,
  itemUnitAmount,
} from "./price-override";
import { StripeService } from "./stripe.service";
import { BillingEventService } from "./billing-event.service";
import { PlatformPricingService } from "./platform-pricing.service";
import { isPayingRow } from "./mrr.service";
import {
  applyCouponStateTx,
  resetCouponState,
  syncCouponFromStripe,
  type CouponSyncOutcome,
} from "./coupon-state";
import { NO_COUPON } from "./coupon-unbilled";
import {
  BILLING_EVENTS,
  BillingEventType,
  planKeyToEnum,
  normalizePlanKey,
  planKeyFromEnum,
} from "./plan-catalog.constants";
import { BillingNotificationService } from "./billing-notification.service";
import { PlanTransitionConfigService } from "./plan-transition-config.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { ScheduledPriceChangeService } from "./scheduled-price-change";
import {
  CHECKOUT_ADDON_EXPAND,
  CHECKOUT_ADDON_SKUS_KEY,
  listedCheckoutAddonSkus,
  checkoutAddonItems,
} from "./stripe-addon-items";
import { lockTenantForLedger } from "./addon-ledger";
import { checkoutAnchorParams, planCheckoutAnchor } from "./checkout-anchor";
import { CatchupClaimService } from "./catchup-claim.service";
import { DunningService } from "./dunning.service";
import type { TransitionOpts } from "./dunning-core";
import { assertTenantNotPaymentOverdue } from "./payment-overdue";
import { transitionToActiveTx, type PauseExit } from "./transition-to-active";
import { claimRefusal, isCatchupSession, isCatchupSubscription } from "./catchup-claim";
import { armNeedsReconcile, clearNeedsReconcile } from "./needs-reconcile";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isStripeResourceMissing } from "./addon.service";
import { billableAddonWhere } from "./addon-row";
import { SUSPENDED_REASON_SUBSCRIPTION_CANCELED } from "./billing-notification.templates";
import { writeAdminNotice } from "./manual-invoice-notice";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { retryOnTxConflict } from "../common/tx-retry";
import {
  STRIPE_CHECKOUT_APPLIED_ACTION,
  STRIPE_CHECKOUT_ASYNC_FAILED_ACTION,
  STRIPE_CHECKOUT_ENTITY,
  STRIPE_CHECKOUT_HOOK_FAILED_ACTION,
  STRIPE_CHECKOUT_DUPLICATE_ACTION,
  STRIPE_CHECKOUT_REFUSED_ACTION,
  STRIPE_CHECKOUT_STALE_ACTION,
  PARKED_CHECKOUT_ESCALATE_AFTER_DAYS,
  STRIPE_CHECKOUT_PARK_ESCALATED_ACTION,
  STRIPE_CHECKOUT_PARK_RESOLVED_ACTION,
  STRIPE_CHECKOUT_PAYMENT_PROCESSING_ACTION,
} from "./config-snapshot-audit.constants";
import {
  isLiveStripeSubscriptionStatus,
  isTerminalStripeSubscriptionStatus,
  stripeBaseItem,
  stripeInvoiceSubscriptionId,
  stripeRefId,
  stripeSubscriptionPeriod,
} from "./stripe-period";

/** Grace period (in days) after a payment failure before suspending the tenant. */
const PAYMENT_GRACE_DAYS = 3;
/** #2476: the payment-failed email's portal call runs inside the webhook's claim lease - cap it so a
 *  slow Stripe can never hold the claim for minutes; on timeout the email falls back to plain text. */
const PAYMENT_FAILED_PORTAL_REQUEST = { timeoutMs: 10_000, maxNetworkRetries: 0 };
/**
 * Clock skew allowed between a manual-activation marker (our database clock) and `session.created` (Stripe's):
 * a marker within this many seconds BEFORE the session counts as AFTER it, i.e. stale. Deliberately lopsided:
 * a false "stale" costs one refund notice an operator can act on (the duplicate is cancelled, nothing is lost),
 * a false "apply" costs the customer double billing (a card subscription on top of a manual invoice).
 */
const MANUAL_MARKER_SKEW_S = 60;

/** Returned by the checkout transaction when the session was already applied (a redelivery). */
const ALREADY_APPLIED = Symbol("checkout-session-already-applied");

/**
 * P0 hotfix: the ONLY Checkout payment states that may ACTIVATE a tenant (and write the APPLIED marker). A card
 * completes `paid`; a 100%-off / free-trial session `no_payment_required`. A bank debit (ACH / SEPA) completes
 * `unpaid` and settles days later: that session is LINKED (customer, subscription, period, plan) but not activated
 * until `checkout.session.async_payment_succeeded` re-delivers it as `paid`. An absent status is NOT settled.
 */
const SETTLED_CHECKOUT_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "no_payment_required",
]);

/** Why a completed checkout session is not applied (X1). */
type DuplicateVerdict = {
  reason: "duplicate_checkout" | "stale_checkout_manual";
  storedSubId: string | null;
};

/** Thrown inside the apply transaction when the under-the-lock re-check finds a duplicate: rolls it back. */
class DuplicateCheckoutSignal extends Error {
  constructor(readonly verdict: DuplicateVerdict) {
    super(`duplicate checkout: ${verdict.reason}`);
  }
}

/**
 * B1158: a paid checkout was PARKED (the superseded subscription's bank payment is still processing): nothing was
 * applied or cancelled; the webhook fails so Stripe redelivers, and the hourly sweep re-judges it. A ConflictException
 * subtype so the sweep can tell "still parked" from any other retryable conflict.
 */
class SupersededPaymentProcessingError extends ConflictException {
  constructor() {
    super(
      "The superseded subscription's payment is still processing — the checkout is parked and retried.",
    );
  }
}

/** A deadlock/serialization failure is a retryable race, not a "hook failed a paid checkout". */
const isDeadlockOrSerialization = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === "P2034" || code === "40P01" || /deadlock/i.test((err as Error)?.message ?? "");
};

/**
 * The ONE shape that disarms a scheduled plans-as-data downgrade (L-072: never hand-type it twice).
 * Spread by the two Stripe lifecycle handlers that must cancel a pending downgrade, both of which
 * are CANCELLATIONS superseding it: subscription deleted, and subscription updated to
 * cancel_at_period_end. A function, not a const, so each write gets a fresh mutable
 * `retainedUserIds` array Prisma's String[] input accepts.
 *
 * B216 (owner ruling 2026-09-14): REINSTATEMENT no longer disarms — see `scheduleLeftArmed()`.
 */
function disarmedDowngrade(): {
  downgradeToPlanKey: null;
  downgradeEffectiveAt: null;
  retainedUserIds: string[];
} {
  return { downgradeToPlanKey: null, downgradeEffectiveAt: null, retainedUserIds: [] };
}

/**
 * B216 (owner ruling 2026-09-14): a reinstatement LEAVES a tenant-chosen scheduled downgrade
 * armed and records that it did so. Paying an invoice is not a statement about which plan the
 * tenant wants — it settles a debt. The previous behaviour disarmed on any real non-ACTIVE→ACTIVE
 * transition, reasoning that a schedule which came due during the lapse would otherwise fire "the
 * first night after reactivation"; but firing IS the tenant's stated intent, and the disarm
 * silently revoked a choice only the tenant had made, with no event and no audit line, leaving
 * them on the plan they had asked to leave. `applyScheduledDowngrades` applies it when due (a
 * schedule already past due applies on the next pass). Mirrors the admin path's
 * `updateStatus()`, which leaves the schedule armed and names it in the admin audit meta.
 *
 * Returns the meta keys the SUBSCRIPTION_RESUMED ledger event carries — same key names the admin
 * audit uses — or `{}` when nothing is armed.
 */
function scheduleLeftArmed(sub: {
  downgradeToPlanKey: string | null;
  downgradeEffectiveAt: Date | null;
}): { downgradeLeftArmed?: string; downgradeEffectiveAt?: string | null } {
  if (!sub.downgradeToPlanKey) return {};
  return {
    downgradeLeftArmed: sub.downgradeToPlanKey,
    downgradeEffectiveAt: sub.downgradeEffectiveAt?.toISOString() ?? null,
  };
}

/**
 * The checkout hook transaction's budget. OUR OWN number, not a Stripe-documented limit: Stripe's
 * webhook docs (https://docs.stripe.com/webhooks) only say to "quickly return a successful status
 * code (2xx) before any complex logic that could cause a timeout", list "(Timed out) ERR — the
 * destination server took too long to respond" as a failed delivery, and retry failures for up to
 * three days in live mode; they publish no seconds figure. So the budget is deliberately short
 * (Prisma's 5 s default is too small for a restore's per-row round trips, an unbounded one risks
 * the "timed out" failure): on timeout the transaction rolls back, the handler answers non-2xx and
 * Stripe's automatic retry runs the checkout again — nothing is lost, only delayed.
 */
const CHECKOUT_TX_OPTIONS = { timeout: 6_000, maxWait: 2_000 } as const;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly email: EmailService,
    private readonly tenantStatusGuard: TenantStatusGuard,
    private readonly events: BillingEventService,
    private readonly pricing: PlatformPricingService,
    private readonly billingNotification: BillingNotificationService,
    // Lane B A2 / B593: a checkout that moves the plan snapshots/restores the tenant's feature
    // config in the same transaction as the subscription write (live flag, default off).
    private readonly planTransition: PlanTransitionConfigService,
    // SA-690 option A: the unbilled self-serve add-ons ride the card checkout as line items, and the
    // completion adopts the resulting Stripe items onto their rows (see SubscriptionMutationService).
    private readonly mutations: SubscriptionMutationService,
    // R1 option B: the `invoice.upcoming` trigger of a scheduled downgrade's Stripe price push.
    @Optional() private readonly scheduledPrice?: ScheduledPriceChangeService,
    // SA-733r3 N2: the October catch-up claim (completion / expiry / paid / failed hooks below).
    @Optional() private readonly catchup?: CatchupClaimService,
    // SA-733r7 PR-B3: dunning (the clock stamp, the hourly pause sweep, the invoice.paid resume).
    @Optional() private readonly dunning?: DunningService,
  ) {
    // MRR has ONE writer: dunning's pause and resume book their delta through this class's transitionAndEmit.
    this.dunning?.bindTransition((...args) => this.transitionAndEmit(...args));
  }

  /**
   * Emit a signed MRR-ledger delta for a Stripe-driven status transition into (+1) or out of
   * (−1) the paying set, so the append-only BillingEvent ledger (and `ledgerMrr`/`momDelta`)
   * tracks the snapshot MRR across legacy-Stripe churn/reactivation.
   *
   * SA-140: gates on `deletedAt`/`class`/`planKey` — the 3 STABLE `isPayingRow` conditions never
   * touched by a Stripe webhook path — via the shared predicate (never re-derived separately).
   * `status` is deliberately NOT one of them here: it's exactly what's transitioning (`toStatus`,
   * fetched by `transitionAndEmit`'s caller), and `direction` (+1 entering / −1 leaving) already
   * encodes which side of the boundary this call is on — re-checking `status === "ACTIVE"` would
   * wrongly gate out every LEAVING transition (`toStatus` is CANCELLED/SUSPENDED there), so this
   * calls `isPayingRow` with `status` forced to `"ACTIVE"` to isolate just the other 3
   * conditions. Contribution = `roundMoney(base + Σ active add-ons − discount)`.
   *
   * Unlike the plans-as-data cron, add-on rows are intentionally NOT toggled: the snapshot
   * includes/excludes add-ons via `tenant.status`, Stripe suspend↔reactivate is reversible, and
   * SUSPENDED/CANCELLED tenants are hard-blocked from `subscribe()` — so there is no
   * subscribe()-reentry that would need the rows deactivated, and leaving them active keeps the
   * −/+ pair symmetric.
   */
  private async emitPayingDelta(
    tenantId: string,
    sub: {
      planKey: string | null;
      basePriceSnapshot: Prisma.Decimal | null;
      discount: Prisma.Decimal | null;
      couponFull: boolean;
    },
    tenant: { deletedAt: Date | null; class: string },
    direction: 1 | -1,
    event: BillingEventType,
    payload: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isPayingRow({ ...tenant, status: "ACTIVE" }, sub.planKey, sub.couponFull)) return;
    // SA-693 / SHOULD-2: only BILLABLE add-ons count — a comp is a platform grant (never revenue), and one that
    // was billed before it became a comp can still carry a stale snapshot.
    const addons = await tx.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId, active: true }),
      select: { priceSnapshot: true, quantity: true },
    });
    const addonMrr = addons.reduce(
      (s, a) => s + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
      0,
    );
    const contribution = roundMoney(
      (sub.basePriceSnapshot != null ? Number(sub.basePriceSnapshot) : 0) +
        addonMrr -
        Number(sub.discount ?? 0),
    );
    await this.events.emit(tenantId, event, payload, {
      amountDelta: contribution ? direction * contribution : 0,
      tx,
    });
  }

  /**
   * Atomically transition a tenant's status (compare-and-swap via a conditional updateMany) and
   * emit the matching signed MRR delta EXACTLY ONCE, in the SAME transaction.
   *
   * The conditional `updateMany` is the idempotency key: concurrent, duplicate, or reordered
   * Stripe webhooks that target the same transition all race on the one row, and only the call
   * that actually flips the status (`count === 1`) emits — so the paired checkout/payment events
   * for a single reactivation, or a duplicate subscription.deleted, can't double-count. Because
   * the status write and the ledger append share one transaction, a failed emit rolls the status
   * back and the webhook/cron simply retries (no half-applied churn).
   *
   * @returns true iff THIS call performed the transition.
   */
  async transitionAndEmit(
    tenantId: string,
    statusWhere: Prisma.TenantWhereInput,
    toStatus: "ACTIVE" | "CANCELLED" | "SUSPENDED" | "READ_ONLY",
    direction: 1 | -1,
    event: BillingEventType,
    payload: Prisma.InputJsonValue,
    // SA-733r7 PR-B3: `tx` joins the caller's transaction (the dunning pause), `data` rides the same CAS (the
    // pause's `readOnlyReason`), `onExit` receives the Stripe pause to clear after commit (the dunning resume).
    opts?: TransitionOpts,
  ): Promise<boolean> {
    const exitBox: { exit: PauseExit | null } = { exit: null };
    const run = async (tx: Prisma.TransactionClient): Promise<boolean> => {
      let count: number;
      if (toStatus === "ACTIVE") {
        // The ONE path back to ACTIVE (SA-733r2 N5): also nulls readOnlyReason and clears the dunning clock + pause
        // in this tx - a Stripe-driven reactivation is a paying tenant, never read-only.
        const to = await transitionToActiveTx(tx, tenantId, {
          where: statusWhere,
          data: opts?.data,
        });
        count = to.count;
        exitBox.exit = to.exit;
      } else {
        ({ count } = await tx.tenant.updateMany({
          where: { ...statusWhere, id: tenantId },
          data: { ...(opts?.data ?? {}), status: toStatus },
        }));
      }
      if (count !== 1) return false;
      // SA-140: emitPayingDelta's gate needs the tenant's deletedAt/class (status/toStatus is
      // deliberately not part of its gate — see the function's own doc comment).
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { deletedAt: true, class: true },
      });
      // SA-736r M1: planKey, snapshot, discount AND couponFull are re-read HERE, inside the tx and after
      // the status CAS (which holds the Tenant row) - never taken from a `sub` read before the tx, which a
      // coupon sync or a plan change can overtake. An absent row is not paying: books nothing.
      const sub = await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: { planKey: true, basePriceSnapshot: true, discount: true, couponFull: true },
      });
      if (sub) await this.emitPayingDelta(tenantId, sub, tenant, direction, event, payload, tx);
      return true;
    };
    const done = opts?.tx ? await run(opts.tx) : await this.prisma.$transaction(run);
    if (done && toStatus === "ACTIVE") {
      // Leaving a pause also leaves Stripe's pause_collection (SA-733r3 F4), AFTER commit: here, or by the caller
      // that took `onExit` (a joined `tx` commits later, so only `onExit` can serve it).
      if (opts?.onExit) opts.onExit(exitBox.exit);
      else if (!opts?.tx) await this.dunning?.clearPauseAfterCommit(exitBox.exit);
    }
    return done;
  }

  /**
   * SA-736r M3: re-derive `couponFull` from Stripe (retrieve + upcoming-invoice preview, never the webhook
   * payload) and write it through the single writer. A failure THROWS - callers keep it OUTSIDE any best-effort
   * try/catch so the webhook ledger records an error and Stripe redelivers.
   */
  private syncCoupon(
    tenantId: string,
    stripeSubId: string,
    reason: string,
  ): Promise<CouponSyncOutcome> {
    return syncCouponFromStripe(
      { prisma: this.prisma, stripe: this.stripe, events: this.events },
      tenantId,
      stripeSubId,
      reason,
    );
  }

  /**
   * SA-736r M5: inside the checkout tx (the Tenant row is locked), a replaced `stripeSubId` takes the old
   * subscription's coupon columns with it. Read BEFORE the upsert; the reset runs AFTER it.
   */
  private async storedStripeSubIdTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string | null> {
    const row = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: { stripeSubId: true },
    });
    return row?.stripeSubId ?? null;
  }

  private async resetCouponIfSubReplacedTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    previousSubId: string | null,
    newSubId: string,
  ): Promise<void> {
    if (previousSubId == null || previousSubId === newSubId) return;
    await applyCouponStateTx(tx, this.events, tenantId, NO_COUPON, {
      reason: "stripe_sub_replaced",
      tenantLockHeld: true,
    });
  }

  // ─── Stripe Customer ──────────────────────────────────────────────────────

  /**
   * Ensure the tenant has a Stripe customer ID. Creates one if missing.
   * Returns the Stripe customer ID.
   */
  async ensureStripeCustomer(tenantId: string): Promise<string> {
    if (!this.stripe.isConfigured) {
      throw new BadRequestException(
        "Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.",
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        subscription: true,
        config: { select: { businessName: true } },
      },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    // Already has a Stripe customer? (the common case: no lock, no write)
    if (tenant.subscription?.stripeCustomerId) {
      return tenant.subscription.stripeCustomerId;
    }

    // Two concurrent checkouts for a tenant with no customer yet would each create one, and the second
    // upsert would orphan the first in Stripe. Serialize the create-and-store per tenant on the shared
    // billing advisory lock (cross-replica; never an in-process lock) and re-read the stored customer
    // INSIDE it, so the second caller finds the first's customer and creates nothing.
    try {
      const result = await withAdvisoryLock(
        { family: "billing", key: `customer:${tenantId}`, mode: "wait", waitMs: 10_000 },
        async () => {
          const stored = await this.prisma.tenantSubscription.findUnique({
            where: { tenantId },
            select: { stripeCustomerId: true },
          });
          if (stored?.stripeCustomerId) return stored.stripeCustomerId;

          // Find admin email for the Stripe customer record
          const adminUser = await this.prisma.user.findFirst({
            where: { tenantId, role: "TENANT_ADMIN", deletedAt: null },
            select: { email: true },
          });

          const customer = await this.stripe.createCustomer({
            email: adminUser?.email ?? `tenant-${tenantId}@routeflow.app`,
            name: tenant.config?.businessName ?? tenant.name ?? tenant.slug,
            metadata: { tenantId, slug: tenant.slug },
          });

          // Upsert the subscription record with the Stripe customer ID
          await this.prisma.tenantSubscription.upsert({
            where: { tenantId },
            create: {
              tenantId,
              stripeCustomerId: customer.id,
              currentPlan: tenant.plan ?? "STARTER",
            },
            update: { stripeCustomerId: customer.id },
          });

          this.logger.log(`Created Stripe customer ${customer.id} for tenant ${tenantId}`);
          return customer.id as string;
        },
      );
      if (!result.acquired) {
        throw new ServiceUnavailableException(
          `Could not serialise the Stripe customer for tenant ${tenantId} — lock unavailable`,
        );
      }
      return result.value;
    } catch (e) {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        this.logger.error(`Stripe customer lock unavailable for tenant ${tenantId}: ${e.message}`);
        throw new ServiceUnavailableException(
          `Could not serialise the Stripe customer for tenant ${tenantId} — retry shortly`,
        );
      }
      throw e;
    }
  }

  // ─── Checkout Session ──────────────────────────────────────────────────────

  /**
   * Creates a Stripe Checkout Session for a tenant to subscribe. Prices are computed
   * inline via `PlatformPricingService` (catalog or per-tenant custom fee) and sent to
   * Stripe as `price_data` — no env-configured Stripe Price IDs involved, so any
   * plan/tier the catalog knows about (including GROWTH/SCALE) can check out.
   * Returns the checkout URL that the tenant owner should visit to pay.
   */
  async createCheckoutSession(
    tenantId: string,
    // Accepts either the plan-specified bare interval (`interval = "month"`) or a
    // fuller opts object (pre-existing callers pass successUrl/cancelUrl this way) —
    // one signature that satisfies both call shapes without touching either caller.
    intervalOrOpts?:
      "month" | "year" | { interval?: "month" | "year"; successUrl?: string; cancelUrl?: string },
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const opts = typeof intervalOrOpts === "string" ? { interval: intervalOrOpts } : intervalOrOpts;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    if (!this.stripe.isConfigured) {
      throw new BadRequestException(
        "Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.",
      );
    }

    const interval: "month" | "year" = opts?.interval === "year" ? "year" : "month";

    // A second checkout on a tenant that already has a live subscription creates a
    // SECOND Stripe subscription on the same customer: both invoice every cycle, and
    // the completion webhook overwrites `stripeSubId`, orphaning the first one where
    // nothing in RouteFlow can see (or cancel) it. Price changes never need a new
    // checkout — they ride the existing subscription via syncStripeSubscriptionPrice.
    // NOTE: this read is deliberately NOT under the Tenant lock. It is a fast refusal, not a guarantee: the claim's
    // authority is the locked CAS in CatchupClaimService.openClaim, and a catch-up completing in between is stopped
    // by the settle-side verification (the session's own subscription), so a race here cannot double-void.
    const existingSub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { stripeSubId: true, externalPayment: true, catchupState: true },
    });
    // SA-733r5 / Opus B1: while a catch-up claim is held, an ORDINARY checkout would create a second subscription
    // whose first paid invoice could be mistaken for the catch-up's. Refused with the claim's own coded 409.
    const held = claimRefusal(existingSub?.catchupState);
    if (held) throw held;
    // SA-733r M1 (PR-B3): a tenant that owes an overdue invoice cannot buy its way out through a new checkout.
    await assertTenantNotPaymentOverdue(
      { prisma: this.prisma, stripe: this.stripe, logger: this.logger },
      tenantId,
      "checkout",
    );
    // Ruling (item 8): a manual-pay (externalPayment) tenant completes card setup ONLY through the catch-up flow,
    // which prices the unpaid periods and voids exactly what it bills. No ordinary checkout for them.
    if (existingSub?.externalPayment === true && !existingSub.stripeSubId) {
      throw new ConflictException({
        code: API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP,
        message:
          "Your account is invoiced directly. Card setup is completed through your RouteFlow contact - " +
          "they will send you a secure payment link.",
      });
    }
    if (existingSub?.stripeSubId) {
      let liveStatus: string | undefined;
      try {
        liveStatus = (await this.stripe.getSubscription(existingSub.stripeSubId))?.status;
      } catch (err) {
        if (!isStripeResourceMissing(err)) {
          // Not "Stripe does not know it": nothing is known about the subscription, and a second checkout
          // would bill the tenant twice if it is live. Fail closed with fixed copy — never Stripe's text.
          this.logger.error(
            `createCheckoutSession tenant ${tenantId}: could not read subscription ${existingSub.stripeSubId} at Stripe: ${(err as Error)?.message}`,
          );
          throw new ServiceUnavailableException(
            "We couldn't check your current subscription with our payment provider. Nothing was created. Please try again.",
          );
        }
        // Stripe no longer knows this subscription (deleted / wrong account) — the
        // stored id is stale, so a fresh checkout is the correct recovery.
        liveStatus = undefined;
      }
      if (isLiveStripeSubscriptionStatus(liveStatus)) {
        throw new BadRequestException(
          `Tenant already has a ${liveStatus} Stripe subscription (${existingSub.stripeSubId}). ` +
            `Change its price with the custom fee / plan price tools (applies at the next ` +
            `billing cycle) — creating another checkout would bill the tenant twice. Cancel ` +
            `the existing subscription first if you really need a new one.`,
        );
      }
    }

    // SA-690 option A: every active self-serve add-on that has no Stripe item yet (a trial's, or a
    // pilot's) is billed on THIS checkout as one extra line. The live-subscription guard above runs
    // first (a tenant that cannot check out never has its add-on rows read); an annual checkout with
    // such an add-on is refused (409, ADDON_ANNUAL_NOT_SUPPORTED) before the customer or the session
    // is created.
    const addons = await this.mutations.checkoutAddonLines(tenantId, interval);

    // SA-733 D6: a new subscription is MONTHLY only - an anchored annual checkout would bill a prorated slice of
    // the YEAR now (10-03 ruling: annual Stripe subscriptions are not offered). Refused before any Stripe call.
    if (interval === "year") {
      throw new BadRequestException({
        code: API_ERROR_CODES.CHECKOUT_ANNUAL_NOT_SUPPORTED,
        message: "Annual checkout is not available. Subscriptions are billed monthly.",
      });
    }

    const customerId = await this.ensureStripeCustomer(tenantId);
    // Throws BadRequestException when neither an override nor a catalog price
    // exists for this tenant's plan (e.g. Enterprise with no custom fee yet).
    const pricing = await this.pricing.resolveTenantPricing(tenantId);
    const priceData = await this.pricing.checkoutPriceData(tenantId, interval);

    const baseUrl = process.env.FRONTEND_URL ?? "http://localhost:3001";
    // SA-733 D6 / M6: ALWAYS an explicit anchor (the next 1st, 12:00 UTC), prorations created, and a session that
    // expires before the anchor so it can never complete after it (Stripe would then charge the full period).
    const anchor = planCheckoutAnchor(new Date());

    // Inline price_data line item — bypasses StripeService.createCheckoutSession
    // (which only accepts a pre-created `priceId`) via the underlying client, since
    // no env-configured Stripe Price exists for catalog-driven plans/tiers.
    const session = await this.stripe.client.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price_data: priceData, quantity: 1 }, ...addons.lineItems],
      success_url:
        opts?.successUrl ?? `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: opts?.cancelUrl ?? `${baseUrl}/billing/cancel`,
      metadata: {
        tenantId,
        slug: tenant.slug,
        planKey: pricing.planKey,
        interval,
        ...(addons.skus.length ? { [CHECKOUT_ADDON_SKUS_KEY]: addons.skus.join(",") } : {}),
      },
      expires_at: anchor.expiresAt,
      subscription_data: {
        ...checkoutAnchorParams(anchor),
        // The SKUs also ride the subscription itself, so a later reader of the subscription (not just
        // the session) can see which add-ons its first invoice billed. A plan-only checkout sends none.
        ...(addons.skus.length
          ? { metadata: { tenantId, [CHECKOUT_ADDON_SKUS_KEY]: addons.skus.join(",") } }
          : {}),
      },
    });

    this.logger.log(
      `Checkout session ${session.id} created for tenant ${tenantId} (plan ${pricing.planKey}, ${interval}, anchor ${anchor.anchorAt.toISOString()})`,
    );
    return { checkoutUrl: session.url, sessionId: session.id };
  }

  // ─── Price sync (admin-driven price changes → live Stripe subscriptions) ──────

  /**
   * Push the tenant's currently-resolved price (override or catalog) onto its live
   * Stripe subscription, taking effect at the NEXT BILLING CYCLE
   * (`proration_behavior: "none"` — owner decision, never mid-period). No-ops with a
   * `reason` when there is no active Stripe subscription to update.
   *
   * Also reconciles the MRR ledger (basePriceSnapshot + a signed BillingEvent
   * `amountDelta`) so reported revenue follows the price actually charged.
   *
   * D8: `opts.pushed` is a push the caller already made Stripe-first (before writing the override), so
   * only the ledger half runs here; `opts.effective` / `proposed` / `version` shape a push made here.
   */
  async syncStripeSubscriptionPrice(
    tenantId: string,
    opts?: PricePushOptions & { pushed?: PricePushResult },
  ): Promise<PricePushResult> {
    // Resolve FIRST: an unresolvable price (isCustom plan with no custom fee) must be a
    // clean no-op result, not a thrown 400 out of a "sync" call — callers fan this out.
    let pricing: Awaited<ReturnType<PlatformPricingService["resolveTenantPricing"]>>;
    try {
      pricing = await this.pricing.resolveTenantPricing(tenantId);
    } catch (err) {
      this.logger.warn(
        `Cannot sync Stripe price for tenant ${tenantId}: ${(err as Error).message}`,
      );
      return { synced: false, reason: "price_unresolvable" };
    }

    const result = opts?.pushed ?? (await this.pushResolvedPriceToStripe(tenantId, opts));
    // Reported MRR must follow the money: basePriceSnapshot is what MrrService prices
    // every paying tenant from, and Σ BillingEvent.amountDelta is what it reconciles
    // against — so a price change writes BOTH, whatever Stripe did.
    await this.reconcilePriceLedger(tenantId, pricing.monthly, pricing.planKey, result);
    // N4: the ledger half landed behind the Stripe push (both agree again): the push's flag comes down.
    if (result.synced) {
      await clearNeedsReconcile(
        { prisma: this.prisma, logger: this.logger },
        tenantId,
        result.reconcile,
      );
    }
    return result;
  }

  /** The Stripe half of `syncStripeSubscriptionPrice` (no ledger side effects). */
  async pushResolvedPriceToStripe(
    tenantId: string,
    opts?: PricePushOptions,
  ): Promise<PricePushResult> {
    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub?.stripeSubId) {
      return { synced: false, reason: "no_active_stripe_subscription" };
    }
    if (!this.stripe.isConfigured) {
      return { synced: false, reason: "stripe_not_configured" };
    }

    let stripeSub: any;
    try {
      stripeSub = await this.stripe.getSubscription(sub.stripeSubId);
    } catch (err) {
      this.logger.error(
        `Failed to retrieve Stripe subscription for tenant ${tenantId}`,
        err as Error,
      );
      return { synced: false, reason: "stripe_retrieve_failed" };
    }

    // SA-733r M7: past_due / unpaid are live — an owner price change must reach their next invoice.
    // A Stripe-side `paused` (or incomplete) subscription is skipped: a price change made while it is
    // paused does NOT reach Stripe, so the resume path (B3) must reconcile the price on resume.
    if (!isLiveStripeSubscriptionStatus(stripeSub.status)) {
      return { synced: false, reason: `subscription_not_active_${stripeSub.status}` };
    }

    // #2440: the base-plan item — never an add-on item Stripe happened to list first, which
    // this sync would otherwise overwrite with the plan price.
    const addonIds = await this.addonItemIds(tenantId);
    const item = stripeBaseItem(stripeSub, addonIds);
    if (!item) {
      return { synced: false, reason: "no_subscription_item" };
    }
    // SA-461: stripeBaseItem falls back to the first item (right for the period read); here that
    // fallback would be an add-on, so there is no base-plan item to reprice.
    if (addonIds.has(item.id)) {
      return { synced: false, reason: "no_base_item" };
    }

    const itemInterval = item.price?.recurring?.interval;
    const interval: "month" | "year" =
      itemInterval === "year" || itemInterval === "month"
        ? itemInterval
        : sub.billingInterval === "year"
          ? "year"
          : "month";

    const priceData = opts?.proposed
      ? await this.pricing.checkoutPriceData(tenantId, interval, opts.proposed)
      : await this.pricing.checkoutPriceData(tenantId, interval);
    const effective = opts?.effective ?? "next_cycle";
    // A mid-period proration on a delinquent subscription would pile onto an invoice nobody pays: past_due /
    // unpaid always take the change at the next invoice, whatever was asked.
    const proration = prorationAllowedFor(stripeSub.status)
      ? prorationBehaviorFor(effective)
      : "none";
    const key = priceOverrideIdempotencyKey({
      tenantId,
      amountCents: priceData.unit_amount,
      proration, // the mode actually SENT: an active -> past_due flip between attempts must not reuse a key
      version: opts?.version,
      itemPriceId: item.price?.id,
      attempt: randomUUID(), // a retry after a cached 5xx must really be sent (the lock + the unchanged check make it safe)
    });
    const oldAmount =
      typeof item.price?.unit_amount === "number" ? fromCents(item.price.unit_amount) : undefined;
    const newAmount = fromCents(priceData.unit_amount);
    // Same cents on the same interval: nothing to change. Re-saving a price with now_prorated would only
    // add net-zero proration lines to the customer's invoice, so Stripe is left alone.
    if (item.price?.unit_amount === priceData.unit_amount) {
      return { synced: true, unchanged: true, oldAmount, newAmount, proration: "none" };
    }

    // Stripe requires a `product` ID on inline price_data for a subscription-item
    // update — `product_data` is a Checkout-session-only shape and is REJECTED here
    // ("unknown parameter"), which would surface as a silent wrong-price. Reuse the
    // item's existing product when present, otherwise create one to point at.
    let productId: string | undefined =
      typeof item.price?.product === "string" ? item.price.product : item.price?.product?.id;
    if (!productId) {
      try {
        const product = await this.stripe.client.products.create(
          { name: priceData.product_data.name },
          { idempotencyKey: `${key}:product` },
        );
        productId = product.id;
      } catch (err) {
        this.logger.error(
          `Failed to create a Stripe product for tenant ${tenantId}'s price sync`,
          err as Error,
        );
        return { synced: false, reason: "stripe_product_create_failed" };
      }
    }
    const updatePriceData: any = {
      currency: priceData.currency,
      unit_amount: priceData.unit_amount,
      recurring: priceData.recurring,
      product: productId,
    };

    // SA-733r3 N4: `needsReconcile` (+ the key/nonce audit row) is COMMITTED before Stripe is touched; the flow
    // clears it after its local write (syncStripeSubscriptionPrice / the override flow). Unwritable => nothing sent.
    const reconcileDeps = { prisma: this.prisma, logger: this.logger };
    let reconcile: { owned: boolean };
    try {
      reconcile = await armNeedsReconcile(reconcileDeps, {
        tenantId,
        kind: "price_override",
        key,
        stripeSubId: sub.stripeSubId,
      });
    } catch (err) {
      this.logger.error(
        `Could not record needsReconcile before pushing tenant ${tenantId}'s price (${(err as Error).message}) - nothing was sent`,
      );
      return { synced: false, reason: "reconcile_flag_failed" };
    }
    // Also logged BEFORE the write: the key is how an operator finds the push if the process dies mid-flight.
    this.logger.log(
      `billing.price_override.push ${JSON.stringify({
        tenantId,
        stripeSubId: sub.stripeSubId,
        idempotencyKey: key,
        priorAmountCents: item.price?.unit_amount ?? null,
        basePriceCents: priceData.unit_amount,
        proration,
        effective,
      })}`,
    );
    try {
      await this.stripe.updateSubscription(
        sub.stripeSubId,
        { items: [{ id: item.id, price_data: updatePriceData }], proration_behavior: proration },
        { idempotencyKey: key },
      );
    } catch (err) {
      this.logger.error(
        `Failed to sync Stripe subscription price for tenant ${tenantId}`,
        err as Error,
      );
      // A lost RESPONSE is not a failed update: Stripe may have applied it. Re-read the item; if it already
      // bills the new amount the push is applied, otherwise it is a failure the caller must refuse.
      const reread = await this.stripe.getSubscription(sub.stripeSubId).catch(() => null);
      if (itemUnitAmount(reread, item.id) !== priceData.unit_amount) {
        // Stripe was READ and did not take it: nothing is ahead, this attempt's flag comes down.
        await clearNeedsReconcile(reconcileDeps, tenantId, reconcile);
        return { synced: false, reason: "stripe_update_failed" };
      }
      this.logger.warn(
        `Stripe price update for tenant ${tenantId} errored but the item already bills ${newAmount} — treating it as applied`,
      );
    }

    this.logger.log(
      `Synced Stripe subscription price for tenant ${tenantId}: ${oldAmount ?? "?"} -> ${newAmount} (${interval}, proration_behavior=${proration})`,
    );
    return { synced: true, oldAmount, newAmount, proration, reconcile };
  }

  /**
   * Keep platform MRR in step with a re-priced tenant: `basePriceSnapshot` is the
   * monthly run-rate MrrService prices each paying subscription from, and the
   * append-only BillingEvent ledger reconciles against Σ `amountDelta`. Without this
   * an admin price change moves the money Stripe collects but neither MRR source.
   *
   * NO-OP entirely when there's no subscription row or it has no resolved `planKey`, or when
   * the run-rate is unchanged. SA-140: the snapshot write below is otherwise UNCONDITIONAL —
   * it always stays current regardless of `isPayingRow` — but the ledger EMIT is gated on it.
   * A non-paying tenant (suspended, or non-PRODUCTION) still gets its snapshot updated so a
   * later re-entry (e.g. reactivation) books the correct price rather than a stale one; booking
   * a delta HERE for a tenant `mrr` never counted would drift `ledgerMrr` above `mrr` — the
   * exact gap B557's mrr.service.ts doc comment names (only `planKey != null` was checked
   * before, never status/deletedAt/class).
   */
  private async reconcilePriceLedger(
    tenantId: string,
    resolvedMonthly: number,
    planKey: string,
    sync: { synced: boolean; reason?: string },
  ): Promise<void> {
    const newMonthly = roundMoney(resolvedMonthly);
    // #2509: ONE transaction per attempt — read, compare-and-set the snapshot on the (planKey,
    // basePriceSnapshot) just read, and emit in the same tx. A concurrent plan change or Pricing write
    // that lands between the read and the write makes the CAS miss instead of being overwritten or
    // double-booked. A miss re-reads: a plan change since the read ⇒ this resolved price is stale for
    // the row, so stop (the plan path wrote its own snapshot); only the snapshot moved ⇒ retry.
    // SA-503a: each attempt's tx is retried on a lock conflict (40P01/40001) — this runs AFTER the fee
    // and the Stripe push committed, so a conflict must never surface as a 500 over a stale snapshot.
    for (let attempt = 0; attempt < TX_CONFLICT_MAX_ATTEMPTS; attempt++) {
      const outcome = await retryOnTxConflict("billing.reconcilePriceLedger", () =>
        this.prisma.$transaction(async (tx) => {
          // SA-485b (ii): the house Tenant row lock, FIRST — lock → read → CAS → emit, so a plan change or
          // Pricing write (every writer takes this lock before the subscription row, #2551) serializes
          // with this reconcile. The CAS below stays as the guard against any write it cannot see.
          await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
          const sub = await tx.tenantSubscription.findUnique({
            where: { tenantId },
            select: {
              planKey: true,
              basePriceSnapshot: true,
              couponFull: true,
              tenant: { select: { status: true, deletedAt: true, class: true } },
            },
          });
          if (!sub || sub.planKey == null) return "done" as const;
          if (normalizePlanKey(sub.planKey) !== normalizePlanKey(planKey)) {
            this.logger.warn(
              `#2509: tenant ${tenantId}'s plan changed during a price sync — the resolved price is stale; not reconciled`,
            );
            return "done" as const;
          }
          const oldMonthly = sub.basePriceSnapshot != null ? Number(sub.basePriceSnapshot) : 0;
          if (oldMonthly === newMonthly) return "done" as const;

          const { count } = await tx.tenantSubscription.updateMany({
            where: { tenantId, planKey: sub.planKey, basePriceSnapshot: sub.basePriceSnapshot },
            data: { basePriceSnapshot: newMonthly },
          });
          if (count === 0) return "retry" as const;

          if (isPayingRow(sub.tenant, sub.planKey, sub.couponFull)) {
            await this.events.emit(
              tenantId,
              BILLING_EVENTS.PLAN_CHANGED,
              {
                source: "platform_pricing_sync",
                planKey,
                oldMonthly,
                newMonthly,
                stripeSynced: sync.synced,
                stripeReason: sync.reason ?? null,
              },
              { amountDelta: roundMoney(newMonthly - oldMonthly), tx },
            );
          }
          return "done" as const;
        }),
      );
      if (outcome === "done") return;
    }
    this.logger.warn(
      `#2509: tenant ${tenantId}'s price reconcile kept losing its compare-and-set — left for the next sync`,
    );
  }

  // ─── Billing Portal ───────────────────────────────────────────────────────

  async createBillingPortalSession(
    tenantId: string,
    returnUrl?: string,
    request?: { timeoutMs: number; maxNetworkRetries: number },
  ): Promise<{ portalUrl: string }> {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });
    if (!sub?.stripeCustomerId) {
      throw new BadRequestException(
        "Tenant does not have a Stripe customer. Create a checkout session first.",
      );
    }

    const baseUrl = process.env.FRONTEND_URL ?? "http://localhost:3001";

    const portalSession = await this.stripe.createBillingPortalSession(
      {
        customerId: sub.stripeCustomerId,
        returnUrl: returnUrl ?? `${baseUrl}/settings/billing`,
      },
      request,
    );

    return { portalUrl: portalSession.url };
  }

  // ─── Webhook handlers ─────────────────────────────────────────────────────

  /**
   * Processes a verified Stripe webhook event.
   * Called by the webhook controller after signature verification.
   */
  async handleWebhookEvent(event: any): Promise<void> {
    this.logger.log(`Processing Stripe event: ${event.type} (${event.id})`);

    switch (event.type) {
      case "checkout.session.completed":
        await this.onCheckoutCompleted(event.data.object);
        // Catch-up claim: advances only a session this handler actually applied; idempotent on a redelivery.
        await this.catchup?.onSessionCompleted(event.data.object);
        break;

      case "checkout.session.async_payment_succeeded":
        // The payload is the now-PAID session: the same handler applies it, exactly once (the APPLIED marker is
        // only written for a settled session, so the unpaid completion before it left none).
        await this.onCheckoutCompleted(event.data.object);
        break;

      case "checkout.session.async_payment_failed":
        // A notice row only: nothing is activated (the unpaid completion never did). Cancel / void is SA-774r2.
        await this.onCheckoutAsyncPaymentFailed(event.data.object);
        break;

      case "checkout.session.expired":
        await this.catchup?.onSessionExpired(event.data.object);
        break;

      case "invoice.paid":
        await this.catchup?.onInvoicePaid(event.data.object);
        // SA-733r7 PR-B3: the ONLY resume (and the only +MRR booking) of a dunning pause; a throw is redelivered.
        await this.dunning?.onInvoicePaid(event.data.object);
        break;

      case "customer.subscription.trial_will_end":
        // SA-733r5: a catch-up subscription is a `trialing` Stripe sub on an ACTIVE tenant. We send no trial email
        // for ANY Stripe trial (the tenant trial emails are ours, keyed on Tenant.status = TRIAL); ignored here.
        this.logger.debug(
          `trial_will_end ignored${isCatchupSubscription(event.data.object) ? " (catch-up subscription)" : ""}`,
        );
        break;

      case "invoice.payment_succeeded":
        await this.onPaymentSucceeded(event.data.object);
        break;

      case "invoice.upcoming":
        await this.onInvoiceUpcoming(event.data.object);
        break;

      case "invoice.payment_failed":
        await this.catchup?.onPaymentFailed(event.data.object);
        await this.onPaymentFailed(event.data.object);
        break;

      case "customer.subscription.deleted":
        await this.onSubscriptionDeleted(event.data.object);
        break;

      case "customer.subscription.updated":
        await this.onSubscriptionUpdated(event.data.object);
        break;

      default:
        this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
    }
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  /**
   * The refusal trail for a checkout session that was not applied (Stripe gets a 200, there is nothing
   * to retry): ONE audit row per session, in the existing audit trail. Exactly one row: two
   * deliveries of the same session (parallel webhook workers, or checkout.session.completed and its
   * async_payment_* sibling) serialize on the same advisory lock the APPLIED path takes, then the
   * second sees the first's committed row. The dedupe key is (entityType, entityId, action) ONLY —
   * the tenant id is payload, because it can differ between deliveries (unknown tenant -> null,
   * tenant created later -> its id). Best-effort: a failure here must never change the 200.
   */
  private async recordCheckoutRefusal(
    session: any,
    tenantId: string | null,
    meta: Prisma.InputJsonObject,
    opts: {
      action?: string;
      alsoWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
      rethrow?: boolean;
    } = {},
  ): Promise<void> {
    const action = opts.action ?? STRIPE_CHECKOUT_REFUSED_ACTION;
    const written = this.prisma.$transaction(async (tx) => {
      if (session.id) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stripe-checkout"}), hashtext(${session.id}))`;
        const recorded = await tx.auditLog.findFirst({
          where: {
            entityType: STRIPE_CHECKOUT_ENTITY,
            entityId: session.id,
            action,
          },
          select: { id: true },
        });
        if (recorded) return;
      }
      await tx.auditLog.create({
        data: {
          tenantId,
          action,
          entityType: STRIPE_CHECKOUT_ENTITY,
          entityId: session.id ?? null,
          meta,
        },
      });
      // Rows that must exist exactly when this one does (the platform notice of a duplicate checkout).
      if (opts.alsoWrite) await opts.alsoWrite(tx);
    }, CHECKOUT_TX_OPTIONS);
    // Best-effort by default: a failure here must never change the 200 Stripe already gets. The duplicate
    // decision is the exception — it must be durable BEFORE the cancel, so it rethrows (the webhook retries).
    if (opts.rethrow) await written;
    else await written.catch(() => undefined);
  }

  /**
   * A PAID session whose own subscription was already cancelled when its completion arrived and that was never
   * applied: money moved and nothing was attached to the tenant, so — beyond the log — it leaves the SHOULD-3
   * trail row and the platform notice (once per session, written together). Raised only when it would be news:
   *  - the session was not paid: nothing was charged;
   *  - it was applied already (its APPLIED row, or the stored subscription IS this one): a late retry of a
   *    session that was handled — the cancellation arrives through customer.subscription.deleted.
   * B1157: a LIVE stored subscription no longer silences it. Every apply path now writes the APPLIED marker in its
   * apply transaction (flag on or off, plan or not), so the A applied, sub_A cancelled, B applied, A retried
   * sequence is silent through A's marker — while a paid session that was NEVER applied alerts even when the
   * tenant is billed fine by another subscription (an operator must refund the orphan charge). Best-effort: a
   * failing write never changes the 200.
   */
  private async noticePaidSessionAlreadyCancelled(
    session: any,
    tenantId: string,
    stripeSub: any,
    stored: { stripeSubId?: string | null; stripeCustomerId?: string | null } | null,
  ): Promise<void> {
    if (session.payment_status !== "paid") return;
    const subscriptionId: string = stripeSub.id;
    const storedSubId = stored?.stripeSubId ?? null;
    if (storedSubId === subscriptionId) return;
    if (session.id && (await this.hasAppliedMarker(tenantId, session.id))) return;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    const label = tenant?.name ?? tenant?.slug ?? tenantId;
    const message =
      `Paid checkout for ${label} was NOT applied: its subscription ${subscriptionId} was already cancelled ` +
      `when the completion arrived, so nothing was attached to the tenant. Check Stripe: refund the first ` +
      `invoice if the cancellation did not.`;
    const trail = this.checkoutCustomerTrail(session, stored, stripeSub);
    this.logger.error(`Tenant ${tenantId}: ${message}`);
    await this.recordCheckoutRefusal(
      session,
      tenantId,
      { reason: "subscription_already_cancelled", ...trail },
      {
        alsoWrite: tenant
          ? (tx) =>
              writeAdminNotice(tx, {
                tenantId,
                action: AdminAuditAction.STRIPE_PAID_CHECKOUT_NOT_APPLIED,
                message,
                meta: {
                  reason: "subscription_already_cancelled",
                  checkoutSessionId: session.id ?? null,
                  sessionPaymentStatus: session.payment_status ?? null,
                  ...trail,
                },
              })
          : undefined,
      },
    );
  }

  /**
   * The add-on adoption of a REDELIVERED (already applied) session — only when the tenant STILL stores the
   * session's own subscription. Otherwise a newer subscription replaced it (A applied, sub_A paused, B applied):
   * adopting would create items on sub_A and swap the rows' pointers off B's items, leaving B's items billing
   * with no row owning them and a resumed sub_A billing twice. A cheap early skip with a log; the per-SKU
   * re-read under the add-on lock (SubscriptionMutationService.adoptCheckoutSku) is what closes the race.
   */
  private async adoptOntoCurrentSubscription(
    tenantId: string,
    subscriptionId: string,
    storedSubId: string | null,
    stripeSub: any,
    adoptCtx: { sessionId?: string | null; listedSkus?: readonly string[] },
  ): Promise<void> {
    if (storedSubId !== subscriptionId) {
      this.logger.warn(
        `checkout.session.completed ${adoptCtx.sessionId ?? "?"} for tenant ${tenantId}: the tenant stores ` +
          `${storedSubId ?? "no subscription"}, not this session's ${subscriptionId} — add-on adoption skipped`,
      );
      return;
    }
    await this.mutations.adoptCheckoutAddons(tenantId, stripeSub, adoptCtx);
  }

  /** The APPLIED marker row of a checkout session: written by EVERY apply path, inside its apply transaction. */
  private async writeAppliedMarker(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sessionId: string,
    meta: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId,
        action: STRIPE_CHECKOUT_APPLIED_ACTION,
        entityType: STRIPE_CHECKOUT_ENTITY,
        entityId: sessionId,
        meta,
      },
    });
  }

  /** Has this checkout session already been APPLIED? (its marker row, written in the apply transaction) */
  private async hasAppliedMarker(
    tenantId: string,
    sessionId: string,
    db: { auditLog: Pick<Prisma.TransactionClient["auditLog"], "findFirst"> } = this.prisma,
  ): Promise<boolean> {
    const row = await db.auditLog.findFirst({
      where: {
        tenantId,
        entityType: STRIPE_CHECKOUT_ENTITY,
        entityId: sessionId,
        action: STRIPE_CHECKOUT_APPLIED_ACTION,
      },
      select: { id: true },
    });
    return row != null;
  }

  /** Has this checkout session already been decided to be a duplicate? (the sticky decision row) */
  private async hasDuplicateDecision(sessionKey: string): Promise<boolean> {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        entityType: STRIPE_CHECKOUT_ENTITY,
        entityId: sessionKey,
        action: STRIPE_CHECKOUT_DUPLICATE_ACTION,
      },
      select: { id: true },
    });
    return row != null;
  }

  /**
   * The tenant's stored subscription at Stripe: its status, and whether that is LIVE. ONLY `resource_missing`
   * (Stripe no longer knows it: status null, not live) means "not live". Any other error — a timeout, a 5xx, a
   * rate limit, a bad key — says nothing about the subscription, and reading it as "not live" would let a paid
   * duplicate overwrite the stored one: it RETHROWS, before anything is written, so the webhook fails and
   * Stripe redelivers.
   */
  private async readStoredSubscription(
    storedSubId: string,
  ): Promise<{ live: boolean; status: string | null }> {
    try {
      const status = (await this.stripe.getSubscription(storedSubId))?.status;
      return {
        live: isLiveStripeSubscriptionStatus(status),
        status: typeof status === "string" ? status : null,
      };
    } catch (err) {
      if (isStripeResourceMissing(err)) return { live: false, status: null };
      this.logger.error(
        `checkout.session.completed: could not read the stored subscription ${storedSubId} at Stripe (${(err as Error)?.message}) — the webhook is retried, nothing was applied`,
      );
      throw err;
    }
  }

  /**
   * B1155: a checkout is about to be applied over a stored subscription that is NOT live but NOT cancelled
   * either (paused / incomplete): it would be left behind, alive in Stripe, with nothing in RouteFlow pointing
   * at it — and a later resume would bill the tenant a second time. Cancel it FIRST (Stripe-first: a failure
   * fails the webhook with nothing applied, and the retry does it again), at once with no proration, under its
   * own idempotency key. A cancel that errors but left it cancelled is done; anything else rethrows.
   */
  private async cancelSupersededSubscription(
    supersededSubId: string,
    status: string,
  ): Promise<void> {
    this.logger.warn(
      `checkout.session.completed: cancelling superseded subscription ${supersededSubId} (${status}) before the new checkout is applied`,
    );
    try {
      await this.stripe.cancelSubscription(
        supersededSubId,
        { prorate: false, invoice_now: false },
        { idempotencyKey: `cancel-superseded:${supersededSubId}` },
      );
    } catch (err) {
      const again = await this.stripe.getSubscription(supersededSubId).catch((e: unknown) => {
        if (isStripeResourceMissing(e)) return { status: "canceled" };
        return null;
      });
      if (!isTerminalStripeSubscriptionStatus(again?.status)) throw err;
    }
  }

  /**
   * B1158: the superseded-subscription cancel, guarded by a fresh re-read of that subscription RIGHT BEFORE it
   * (the status read at the top of the handler is stale by now, and a bank payment may be in flight on it):
   *  - now LIVE: do NOT cancel — a retryable throw, so the redelivery re-judges the checkout as a duplicate;
   *  - terminal / gone: nothing to cancel, the checkout applies;
   *  - its latest invoice's PaymentIntent is `processing` (ACH / SEPA): PARK the checkout — nothing cancelled, nothing
   *    applied, ONE trail row + ONE platform notice per session — and fail the webhook so Stripe redelivers (the
   *    hourly sweep resolves it);
   *  - otherwise: cancel, as before.
   */
  private async cancelSupersededUnlessProcessing(
    session: any,
    tenantId: string,
    stripeSub: any,
    existing: { stripeCustomerId?: string | null } | null,
    storedSubId: string,
  ): Promise<void> {
    const fresh = await this.stripe.getSubscriptionPaymentState(storedSubId);
    if (isLiveStripeSubscriptionStatus(fresh.status)) {
      throw new ConflictException(
        "The superseded subscription became live while this checkout was being applied — the checkout is retried.",
      );
    }
    // A bank payment in flight parks the checkout even when the status already reads terminal: the payment
    // may still settle, so nothing is applied or cancelled until it resolves.
    if (fresh.paymentProcessing) {
      await this.parkCheckoutForProcessingPayment(
        session,
        tenantId,
        stripeSub,
        existing,
        storedSubId,
      );
      throw new SupersededPaymentProcessingError();
    }
    if (fresh.status === null || isTerminalStripeSubscriptionStatus(fresh.status)) return;
    await this.cancelSupersededSubscription(storedSubId, fresh.status);
  }

  /** The durable half of a park: the trail row and its platform notice, written together (once per session). */
  private async parkCheckoutForProcessingPayment(
    session: any,
    tenantId: string,
    stripeSub: any,
    existing: { stripeCustomerId?: string | null } | null,
    storedSubId: string,
  ): Promise<void> {
    const newSubId: string = stripeSub.id;
    const trail = this.checkoutCustomerTrail(session, existing, stripeSub);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    const label = tenant?.name ?? tenant?.slug ?? tenantId;
    const message =
      `Paid checkout for ${label} is parked: the tenant's previous subscription ${storedSubId} has a bank payment ` +
      `still processing; the new paid checkout ${session.id ?? "?"} / subscription ${newSubId} is parked, NOT applied; ` +
      `nothing was cancelled. RouteFlow re-checks hourly and resolves it automatically (payment succeeds: the new ` +
      `subscription is treated as a duplicate and cancelled, with a refund notice; payment fails: the new checkout ` +
      `is applied); do not cancel either subscription by hand.`;
    this.logger.warn(`Tenant ${tenantId}: ${message}`);
    await this.recordCheckoutRefusal(
      session,
      tenantId,
      { reason: "superseded_payment_processing", storedSubId, newSubId, ...trail },
      {
        action: STRIPE_CHECKOUT_PAYMENT_PROCESSING_ACTION,
        rethrow: true,
        alsoWrite: tenant
          ? (tx) =>
              writeAdminNotice(tx, {
                tenantId,
                action: AdminAuditAction.STRIPE_PAID_CHECKOUT_NOT_APPLIED,
                message,
                meta: {
                  reason: "superseded_payment_processing",
                  checkoutSessionId: session.id ?? null,
                  storedSubId,
                  newSubId,
                },
              })
          : undefined,
      },
    );
  }

  /**
   * B1158: hourly, re-run the SAME checkout handling (`onCheckoutCompleted`, the webhook's own path) for every
   * parked checkout that has no resolution row yet. Handled (applied, or judged a duplicate and cancelled) writes
   * the PARK_RESOLVED row; parked again (payment still processing) stays open — and once it has been open longer
   * than PARKED_CHECKOUT_ESCALATE_AFTER_DAYS, ONE escalation notice asks for a manual reconcile in Stripe. One row
   * failing never stops the others. Idempotent across runs and replicas (LeaderCron; every write dedupes on the
   * session under the same advisory lock the webhook takes).
   */
  @LeaderCron("0 * * * *", "billing.reconcileParkedCheckouts")
  async reconcileParkedCheckouts(): Promise<void> {
    if (!this.stripe.isConfigured) return;
    // Open parks only: NOT EXISTS a resolution row for the same entity, in the query itself (Prisma cannot
    // express a NOT EXISTS across rows of one table). `escalated` = an ESCALATED row exists for the entity.
    const parked = await this.prisma.$queryRaw<
      { entityId: string; tenantId: string | null; createdAt: Date; escalated: boolean }[]
    >`
      SELECT a."entityId", a."tenantId", a."createdAt",
        EXISTS (
          SELECT 1 FROM "AuditLog" e
          WHERE e."entityType" = a."entityType" AND e."entityId" = a."entityId"
            AND e."action" = ${STRIPE_CHECKOUT_PARK_ESCALATED_ACTION}
        ) AS "escalated"
      FROM "AuditLog" a
      WHERE a."entityType" = ${STRIPE_CHECKOUT_ENTITY}
        AND a."action" = ${STRIPE_CHECKOUT_PAYMENT_PROCESSING_ACTION}
        AND a."entityId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "AuditLog" r
          WHERE r."entityType" = a."entityType" AND r."entityId" = a."entityId"
            AND r."action" = ${STRIPE_CHECKOUT_PARK_RESOLVED_ACTION}
        )
      ORDER BY a."createdAt" ASC`;
    // An escalated park already told the platform; re-run it once a day (the UTC-midnight run), not hourly.
    const dailyRun = new Date(Date.now()).getUTCHours() === 0;
    for (const row of parked) {
      if (row.escalated && !dailyRun) continue;
      try {
        await this.reconcileParkedCheckout(row.entityId, row.createdAt);
      } catch (err) {
        this.logger.error(
          `billing.reconcileParkedCheckouts: parked checkout ${row.entityId} could not be re-run (${(err as Error)?.message}) — left open, retried next hour`,
        );
        // A re-run that keeps failing must not hide an old park: escalate once from the row's own ids.
        // Passes a partial `{ id }` session: escalateParkedCheckout reads only `session.id`.
        if (
          row.tenantId &&
          Date.now() - row.createdAt.getTime() >
            PARKED_CHECKOUT_ESCALATE_AFTER_DAYS * 24 * 3600 * 1000
        ) {
          await this.escalateParkedCheckout({ id: row.entityId }, row.tenantId, true).catch((e) =>
            this.logger.error(
              `billing.reconcileParkedCheckouts: escalation for ${row.entityId} failed (${(e as Error)?.message})`,
            ),
          );
        }
      }
    }
  }

  private async reconcileParkedCheckout(sessionId: string, parkedAt: Date): Promise<void> {
    const session = await this.stripe.getCheckoutSession(sessionId);
    const tenantId: string | null = session?.metadata?.tenantId ?? null;
    try {
      await this.onCheckoutCompleted(session);
    } catch (err) {
      if (!(err instanceof SupersededPaymentProcessingError)) throw err;
      const ageMs = Date.now() - parkedAt.getTime();
      if (tenantId && ageMs > PARKED_CHECKOUT_ESCALATE_AFTER_DAYS * 24 * 3600 * 1000) {
        await this.escalateParkedCheckout(session, tenantId);
      }
      return; // still parked: stays open
    }
    await this.recordCheckoutRefusal(
      session,
      tenantId,
      { reason: "park_resolved" },
      { action: STRIPE_CHECKOUT_PARK_RESOLVED_ACTION, rethrow: true },
    );
  }

  private async escalateParkedCheckout(
    session: any,
    tenantId: string,
    rerunFailing = false,
  ): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    if (!tenant) return;
    const label = tenant.name ?? tenant.slug ?? tenantId;
    const message =
      `Paid checkout ${session.id} for ${label} has been parked for more than ` +
      `${PARKED_CHECKOUT_ESCALATE_AFTER_DAYS} days: the previous subscription's bank payment is still processing. ` +
      `Nothing was applied or cancelled${rerunFailing ? "; the hourly re-run itself is failing for this session" : ""} — manual reconcile in Stripe now.`;
    this.logger.error(`Tenant ${tenantId}: ${message}`);
    await this.recordCheckoutRefusal(
      session,
      tenantId,
      { reason: "superseded_payment_processing_escalated" },
      {
        action: STRIPE_CHECKOUT_PARK_ESCALATED_ACTION,
        rethrow: true,
        alsoWrite: (tx) =>
          writeAdminNotice(tx, {
            tenantId,
            action: AdminAuditAction.STRIPE_PAID_CHECKOUT_NOT_APPLIED,
            message,
            meta: {
              reason: "superseded_payment_processing_escalated",
              checkoutSessionId: session.id ?? null,
            },
          }),
      },
    );
  }

  /**
   * X1 — is this completed session a STALE checkout over a newer billing state? Pure over the row it is
   * given (called from the early read and again, from the re-read row, under the tenant lock):
   *  - duplicate_checkout: the tenant already stores a DIFFERENT, live subscription (two sessions were
   *    paid); the stored subscription equal to the session's is the applied one — never a duplicate;
   *  - stale_checkout_manual: the tenant is on manual invoicing (externalPayment) and its LATEST manual
   *    activation or renewal — the in-transaction marker row — committed AFTER the session was created, to within
   *    MANUAL_MARKER_SKEW_S. A manual activation from well before the session (a tenant that chose to pay by
   *    card) is not stale, and neither is a cron cycle roll, which writes no marker.
   */
  private judgeDuplicate(
    session: any,
    subscriptionId: string,
    row: {
      stripeSubId?: string | null;
      externalPayment?: boolean | null;
    } | null,
    storedLive: boolean,
    manualActivatedAt: Date | null,
  ): DuplicateVerdict | null {
    const stored = row?.stripeSubId ?? null;
    if (stored === subscriptionId) return null;
    if (stored && storedLive) return { reason: "duplicate_checkout", storedSubId: stored };
    const created = typeof session.created === "number" ? session.created : null;
    if (
      row?.externalPayment === true &&
      created != null &&
      manualActivatedAt != null &&
      manualActivatedAt.getTime() >= (created - MANUAL_MARKER_SKEW_S) * 1000
    ) {
      return { reason: "stale_checkout_manual", storedSubId: stored };
    }
    return null;
  }

  /**
   * When the tenant's LATEST manual activation (or renewal) committed: the newest `createdAt` over BOTH the
   * in-transaction marker row and the legacy TENANT_SUBSCRIPTION_ACTIVATED trail row — never `periodStart`,
   * which the billing cron's cycle roll also moves. Tenant-scoped, and called with the tenant lock held (inside
   * the apply transaction) for the decisive read.
   *  - the marker is decisive: written in the activation's own transaction, so it exists exactly when the
   *    activation does;
   *  - the trail row is best-effort (AuditService swallows errors) and lands AFTER the commit, so on its own it
   *    can only be missing or a moment late. It is read for the activations that predate the marker (no migration
   *    or backfill): it can only lean toward STALE (a later time), never make a later marker look older;
   *  - with neither row there is nothing to say the tenant moved to manual invoicing after the session: not stale.
   */
  private async latestManualActivationAt(
    db: { auditLog: { findFirst: (args: any) => Promise<{ createdAt: Date } | null> } },
    tenantId: string,
  ): Promise<Date | null> {
    const latest = await db.auditLog.findFirst({
      where: {
        tenantId,
        entityType: ADMIN_AUDIT_ENTITY,
        action: {
          in: [
            AdminAuditAction.TENANT_MANUAL_ACTIVATION_MARKER,
            AdminAuditAction.TENANT_SUBSCRIPTION_ACTIVATED,
          ],
        },
      },
      orderBy: [{ createdAt: "desc" }],
      select: { createdAt: true },
    });
    return latest?.createdAt ?? null;
  }

  /**
   * A duplicate checkout was found: record the STICKY decision and the platform notice together (one
   * transaction, one row each per session, BEFORE anything is cancelled), then cancel the duplicate. No
   * automatic refund — an operator refunds the first invoice from the notice.
   */
  private async handleDuplicate(
    session: any,
    tenantId: string,
    stripeSub: any,
    verdict: DuplicateVerdict,
  ): Promise<void> {
    const subId: string = stripeSub.id;
    const invoiceId = stripeRefId(stripeSub.latest_invoice);
    // The invoice's amount and paid state for the notice (best-effort: the cancel must not wait on it).
    let invoice: any = null;
    if (invoiceId) {
      try {
        invoice = await this.stripe.getInvoice(invoiceId);
      } catch {
        invoice = null;
      }
    }
    const charged = session.payment_status === "paid" || invoice?.status === "paid";
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    const label = tenant?.name ?? tenant?.slug ?? tenantId;
    const amountCents: number | null =
      typeof invoice?.amount_due === "number"
        ? invoice.amount_due
        : typeof invoice?.total === "number"
          ? invoice.total
          : null;
    const message = charged
      ? `Duplicate checkout for ${label} — first invoice ${invoiceId ?? "(none)"} on ${subId} was charged; refund it in Stripe.`
      : `Duplicate checkout for ${label} — first invoice ${invoiceId ?? "(none)"} on ${subId} was not paid and is voided; nothing to refund.`;
    this.logger.error(
      `checkout.session.completed ${session.id ?? "?"} is a DUPLICATE for tenant ${tenantId} (${verdict.reason}; ` +
        `stored subscription ${verdict.storedSubId ?? "(none)"}): cancelling ${subId}, no automatic refund — ${message}`,
    );
    await this.recordCheckoutRefusal(
      session,
      tenantId,
      {
        reason: verdict.reason,
        subscriptionId: subId,
        storedSubscriptionId: verdict.storedSubId,
        latestInvoice: invoiceId,
        invoiceAmountCents: amountCents,
        invoicePaid: invoice?.status === "paid",
        sessionPaymentStatus: session.payment_status ?? null,
      },
      {
        action: STRIPE_CHECKOUT_DUPLICATE_ACTION,
        rethrow: true,
        alsoWrite: (tx) =>
          writeAdminNotice(tx, {
            tenantId,
            action: AdminAuditAction.STRIPE_DUPLICATE_CHECKOUT,
            message,
            meta: {
              subscriptionId: subId,
              storedSubscriptionId: verdict.storedSubId,
              invoiceId,
              invoiceAmountCents: amountCents,
              invoicePaid: invoice?.status === "paid",
              checkoutSessionId: session.id ?? null,
              reason: verdict.reason,
            },
          }),
      },
    );
    await this.finishDuplicate(session, stripeSub);
  }

  /**
   * The Stripe half of a duplicate decision, safe to repeat: cancel the duplicate subscription at once with
   * no proration (never refund it automatically) under the key `cancel-dup:<session>`; on a Stripe error
   * re-read it — already cancelled is done, anything else rethrows so a redelivery retries. A session that
   * was NOT paid also has its still-open first invoice voided, so it can never be collected later.
   */
  private async finishDuplicate(session: any, stripeSub: any): Promise<void> {
    const subId: string = stripeSub.id;
    if (stripeSub.status !== "canceled") {
      try {
        await this.stripe.cancelSubscription(
          subId,
          { prorate: false, invoice_now: false },
          { idempotencyKey: `cancel-dup:${session.id ?? subId}` },
        );
      } catch (err) {
        const again = await this.stripe.getSubscription(subId).catch(() => null);
        if (again?.status !== "canceled") throw err;
      }
    }
    if (session.payment_status !== "paid") {
      const invoiceId = stripeRefId(stripeSub.latest_invoice);
      if (invoiceId) {
        const invoice = await this.stripe.getInvoice(invoiceId);
        if (invoice?.status === "open") await this.stripe.voidInvoice(invoiceId);
      }
    }
  }

  /**
   * SA-690: the customer the session was paid under must be the tenant's — whatever the
   * plan-transition flag says (it fails closed to OFF). The signature proves the Stripe account, not
   * that RouteFlow created this session, and a completion writes rows and creates/deletes Stripe items
   * from `session.metadata.tenantId`. So the tenant's STORED customer, the session's customer and the
   * retrieved subscription's customer must all be the same one. Returns true when they are.
   *
   * Otherwise NOTHING is applied (no row write, no Stripe item created or deleted), the ids are logged
   * at error level, and a trail row is left (the existing refused-checkout record) carrying the
   * subscription and its add-on item ids: those items keep billing in Stripe with no row owning them,
   * so someone has to be able to find them. The caller then answers 200 — a retry cannot fix it.
   */
  private async checkoutCustomerVerified(
    session: any,
    tenantId: string,
    stored: { stripeCustomerId?: string | null } | null,
    stripeSub: any,
  ): Promise<boolean> {
    const storedCustomer = stored?.stripeCustomerId ?? null;
    const sessionCustomer = stripeRefId(session.customer);
    const subscriptionCustomer = stripeRefId(stripeSub?.customer);
    if (
      storedCustomer &&
      storedCustomer === sessionCustomer &&
      storedCustomer === subscriptionCustomer
    ) {
      return true;
    }
    const trail = this.checkoutCustomerTrail(session, stored, stripeSub);
    this.logger.error(
      `checkout.session.completed NOT APPLIED for tenant ${tenantId} (session ${session.id ?? "?"}): ` +
        `the customer is not the tenant's — stored ${storedCustomer ?? "(none)"}, ` +
        `session ${sessionCustomer ?? "(none)"}, subscription ${subscriptionCustomer ?? "(none)"} ` +
        `(subscription ${trail.subscriptionId ?? "?"} ${trail.subscriptionStatus ?? "?"} — ` +
        `${trail.chargedButNotRecorded ? "CHARGED but not recorded: refund or reconcile" : "not charged"}, ` +
        `add-on items ${trail.addonItemIds.join(",") || "none"})`,
    );
    // SHOULD-3: money moved (the session says paid, or the subscription is active/trialing) for a tenant that
    // has no customer on file — or no subscription row at all — so there is nothing here to verify it against and
    // NOTHING was applied. Someone has to attach the customer and replay it, or refund it: tell the platform, in the
    // same transaction as the (once-per-session) trail row. A customer MISMATCH keeps the trail + log only.
    const charged = session.payment_status === "paid" || trail.chargedButNotRecorded;
    let notice: ((tx: Prisma.TransactionClient) => Promise<void>) | undefined;
    if (!storedCustomer && charged) {
      const known = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, slug: true },
      });
      if (known) {
        const label = known.name ?? known.slug ?? tenantId;
        const message =
          `Paid checkout for ${label} was NOT applied: no Stripe customer is on file for this tenant, so the ` +
          `session's customer ${trail.sessionCustomer ?? "(none)"} could not be verified. Subscription ` +
          `${trail.subscriptionId ?? "(unknown)"} is ${trail.subscriptionStatus ?? "in an unknown state"} and ` +
          `${trail.chargedButNotRecorded ? "was charged" : "may have been charged"} — attach the customer and ` +
          `replay the event, or refund it in Stripe.`;
        notice = (tx) =>
          writeAdminNotice(tx, {
            tenantId,
            action: AdminAuditAction.STRIPE_PAID_CHECKOUT_NOT_APPLIED,
            message,
            meta: {
              reason: "customer_not_on_file",
              checkoutSessionId: session.id ?? null,
              sessionPaymentStatus: session.payment_status ?? null,
              ...trail,
            },
          });
      }
    }
    await this.recordCheckoutRefusal(
      session,
      stored ? tenantId : null,
      {
        reason: storedCustomer ? "customer_mismatch" : "customer_not_on_file",
        ...trail,
      },
      notice ? { alsoWrite: notice } : {},
    );
    return false;
  }

  /**
   * The ids a refused checkout's trail row carries so the Stripe side can be found and dealt with:
   * the three customers compared, the subscription, and the add-on items that subscription holds.
   */
  private checkoutCustomerTrail(
    session: any,
    stored: { stripeCustomerId?: string | null } | null,
    stripeSub: any,
  ) {
    return {
      storedCustomer: stored?.stripeCustomerId ?? null,
      sessionCustomer: stripeRefId(session.customer),
      subscriptionCustomer: stripeRefId(stripeSub?.customer),
      subscriptionId: stripeRefId(stripeSub),
      addonItemIds: checkoutAddonItems(stripeSub)
        .map((i) => i.itemId)
        .sort(),
      // Stripe has ALREADY taken (or will take, for a trial) the money for a subscription in one of
      // these states while nothing here was recorded: an operator has to refund or reconcile it.
      subscriptionStatus: typeof stripeSub?.status === "string" ? stripeSub.status : null,
      chargedButNotRecorded: stripeSub?.status === "active" || stripeSub?.status === "trialing",
    };
  }

  /**
   * `checkout.session.async_payment_failed`: the bank debit of a checkout that was linked unpaid did NOT clear. The
   * tenant was never activated by it (see onCheckoutCompleted), so there is nothing to undo here: ONE audit row per
   * session plus a platform notice. Cancelling the linked subscription / voiding is SA-774r2. Best-effort: a failed
   * write never changes the 200 Stripe gets.
   */
  private async onCheckoutAsyncPaymentFailed(session: any): Promise<void> {
    const tenantId: string | null = session.metadata?.tenantId ?? null;
    this.logger.warn(
      `checkout.async_payment_failed ${session.id ?? "?"} for tenant ${tenantId ?? "?"}: the bank debit failed - ` +
        `nothing was activated by this checkout`,
    );
    if (!tenantId) return;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    const label = tenant?.name ?? tenant?.slug ?? tenantId;
    // A session that completed BEFORE the hotfix activated the tenant and left its APPLIED marker: its debit has now
    // failed, so that tenant is ACTIVE and UNPAID. The notice must say so, never "nothing was activated".
    const wasActivated = session.id ? await this.hasAppliedMarker(tenantId, session.id) : false;
    const message = wasActivated
      ? `The bank debit for ${label}'s checkout FAILED, and that checkout ACTIVATED the tenant before the payment ` +
        `cleared (completed before the payment gate): the tenant is ACTIVE and UNPAID. Follow up or suspend it, and ` +
        `check Stripe (a failed debit is not cancelled automatically yet).`
      : `The bank debit for ${label}'s checkout FAILED: it was not activated by this checkout. ` +
        `Check Stripe and follow up with the tenant (a failed debit is not cancelled automatically yet).`;
    const notice = {
      tenantId,
      action: AdminAuditAction.STRIPE_ASYNC_PAYMENT_FAILED,
      message,
      meta: {
        reason: "async_payment_failed",
        activated: wasActivated,
        checkoutSessionId: session.id ?? null,
        sessionPaymentStatus: session.payment_status ?? null,
      },
    };
    await this.recordCheckoutRefusal(
      session,
      tenant ? tenantId : null, // an unknown tenant id would fail the AuditLog FK and leave no trail
      {
        reason: "async_payment_failed",
        activated: wasActivated,
        checkoutSessionId: session.id ?? null,
      },
      {
        action: STRIPE_CHECKOUT_ASYNC_FAILED_ACTION,
        alsoWrite: tenant ? (tx) => writeAdminNotice(tx, notice) : undefined,
      },
    );
  }

  private async onCheckoutCompleted(session: any): Promise<void> {
    const tenantId = session.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn("checkout.session.completed without tenantId metadata");
      return;
    }

    const subscriptionId =
      typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

    if (!subscriptionId) {
      this.logger.warn("checkout.session.completed without subscription ID");
      return;
    }

    // P0 hotfix: is the money in (or none due)? Only then may this session ACTIVATE the tenant and write its APPLIED
    // marker; an unpaid session (an ACH debit in flight) still LINKS the customer / subscription / period / plan below.
    const settled = SETTLED_CHECKOUT_PAYMENT_STATUSES.has(session.payment_status ?? "");

    // Fetch the full subscription to get period dates. SA-690: with each item's product expanded, so
    // the add-on items this checkout billed (tagged `addonSku` on their product) can be told apart
    // from the base plan item and adopted onto their rows below. Retrieved BEFORE anything is
    // written: a Stripe failure here fails the webhook with nothing applied, and Stripe redelivers.
    const stripeSub = await this.stripe.getSubscription(subscriptionId, {
      expand: CHECKOUT_ADDON_EXPAND,
    });
    // #2436: under API dahlia the period lives on the items; null ⇒ write no period, never NaN.
    // The checkout's own add-on items are not the base plan item (N2) — their rows carry no
    // stripeItemId yet, so they are named here explicitly.
    const period = await this.subscriptionPeriod(
      stripeSub,
      tenantId,
      "checkout.session.completed",
      checkoutAddonItems(stripeSub).map((i) => i.itemId),
    );
    // Platform billing: which interval the tenant checked out with (set in
    // BillingService.createCheckoutSession metadata), stamped for sync/resume use.
    const billingInterval: string | undefined =
      session.metadata?.interval === "year" || session.metadata?.interval === "month"
        ? session.metadata.interval
        : undefined;

    // B445: checkout stamps `metadata.planKey` (createCheckoutSession, :291); `metadata.plan`
    // is the legacy fallback. present-only — never overwrite an existing non-null planKey with
    // null on an idempotent replay, and never regress a row some OTHER path already correctly
    // populated (guarded below via the `update` branch's conditional spread).
    const resolvedPlanKey: string | null =
      session.metadata?.planKey ?? session.metadata?.plan ?? null;

    // resolveCatalogPricing already falls back tenant.subscription?.planKey ?? tenant.plan, so it
    // resolves correctly even before planKey is written below. It can throw BadRequestException
    // (isCustom plan, no price) — a webhook handler must never throw uncaught (Stripe retries
    // forever), so this is best-effort: planKey still gets recorded, basePriceSnapshot left unset.
    let resolvedBasePrice: number | null = null;
    try {
      resolvedBasePrice = (await this.pricing.resolveCatalogPricing(tenantId)).monthly;
    } catch (err) {
      this.logger.warn(
        `checkout.session.completed: could not resolve catalog price for tenant ${tenantId} (${(err as Error).message}) — planKey recorded, basePriceSnapshot left unset`,
      );
    }

    // Finding 4 (Lite-L2 review, money): resolveCatalogPricing is DELIBERATELY catalog-only,
    // ignoring any per-tenant negotiated override (see its own doc comment) — correct for its
    // other callers, but wrong to blindly write into basePriceSnapshot here. A tenant with a
    // negotiated custom fee (priceOverrideMonthly/priceOverrideAnnual) must keep it; this
    // webhook has no business reason to overwrite it with the catalog figure.
    const existingOverride = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        priceOverrideMonthly: true,
        priceOverrideAnnual: true,
        planKey: true,
        stripeCustomerId: true,
        // X1: the stale/duplicate-checkout guard judges from these (and re-reads them under the lock).
        stripeSubId: true,
        externalPayment: true,
      },
    });
    const hasNegotiatedOverride =
      existingOverride?.priceOverrideMonthly != null ||
      existingOverride?.priceOverrideAnnual != null;

    // SA-690: for every session — flag on or off — the customer must be the tenant's before ANYTHING
    // below is written or read for it: not the plan, not an add-on item, not even the stale-downgrade
    // audit row and admin email further down (see checkoutCustomerVerified). The flag-on guard below
    // is NOT enough on its own: it lets a tenant with no customer on file, and a stored customer that
    // matches the session's while the subscription's differs, straight through.
    if (!(await this.checkoutCustomerVerified(session, tenantId, existingOverride, stripeSub))) {
      return;
    }

    // X1 — a STALE checkout never completes over a newer billing state. Judged BEFORE anything below
    // can write (the stale-downgrade branch still writes the Stripe ids), and STICKY: once a session was
    // decided to be a duplicate, a redelivery only retries the cancel and never re-judges it.
    // SA-690: the add-on SKUs this checkout LISTED (on the session and on the subscription it made): each must
    // have a recognised item at adoption, and a listed SKU that has none is never billed a second time.
    const adoptCtx = {
      sessionId: session.id,
      listedSkus: listedCheckoutAddonSkus(session.metadata, stripeSub?.metadata),
    };
    const duplicateKey: string = session.id ?? subscriptionId;
    if (await this.hasDuplicateDecision(duplicateKey)) {
      await this.finishDuplicate(session, stripeSub);
      return;
    }
    // S2 — a session that is not a FRESH completion is never judged a duplicate, and never raises a refund
    // notice: the duplicate verdict compares it with whatever is stored NOW, and a LATE retry of a session that
    // was long since handled (A applied, sub_A then cancelled, B applied, A's webhook retried) would read
    // as "a different live subscription is stored" and tell an operator to refund a legitimate charge.
    //  - its own subscription is already cancelled: nothing to apply or adopt (writing it would point the
    //    tenant at a dead subscription over the live one) and nothing to refund through this path;
    //  - it already has its APPLIED row: an idempotent redelivery (adopt, never re-judge).
    if (stripeSub?.status === "canceled") {
      this.logger.warn(
        `checkout.session.completed ${session.id ?? "?"} for tenant ${tenantId}: its subscription ${subscriptionId} is already cancelled — nothing applied`,
      );
      await this.noticePaidSessionAlreadyCancelled(session, tenantId, stripeSub, existingOverride);
      return;
    }
    if (session.id && (await this.hasAppliedMarker(tenantId, session.id))) {
      this.logger.log(`checkout.session.completed ${session.id} already applied — ignoring`);
      // SA-690: the add-on adoption is idempotent (a row that already holds its item books nothing) and runs
      // on a redelivery too — an earlier attempt may have applied the plan and then failed on Stripe before
      // adopting, and a retry that skipped it would leave the customer billed for an item no row owns. But ONLY
      // onto the subscription the tenant STILL stores: after A applied, sub_A paused and B applied, a redelivery
      // of A must not create items on sub_A or swap B's rows off B's items.
      await this.adoptOntoCurrentSubscription(
        tenantId,
        subscriptionId,
        existingOverride?.stripeSubId ?? null,
        stripeSub,
        adoptCtx,
      );
      // SA-736r F2: the redelivery syncs the coupon too (idempotent), so a sync that threw after the first
      // delivery's upsert is retried here instead of being lost behind "already applied".
      await this.syncCoupon(tenantId, subscriptionId, "checkout_completed");
      return;
    }
    const storedSubId: string | null = existingOverride?.stripeSubId ?? null;
    // The stored subscription's liveness is read at Stripe HERE, outside any transaction (never a
    // Stripe call under the tenant lock); the transactions below re-read the stored id under the lock
    // and refuse to proceed if it moved.
    const stored =
      storedSubId && storedSubId !== subscriptionId
        ? await this.readStoredSubscription(storedSubId)
        : { live: false, status: null as string | null };
    const storedLive = stored.live;
    // Staleness is keyed on the manual activation's own marker (read only for a manual row).
    const earlyManualAt =
      existingOverride?.externalPayment === true
        ? await this.latestManualActivationAt(this.prisma, tenantId)
        : null;
    const earlyVerdict = this.judgeDuplicate(
      session,
      subscriptionId,
      existingOverride,
      storedLive,
      earlyManualAt,
    );
    if (earlyVerdict) {
      await this.handleDuplicate(session, tenantId, stripeSub, earlyVerdict);
      return;
    }
    // B1155: this checkout is going to REPLACE a stored subscription that is neither live nor cancelled
    // (paused / incomplete): cancel that one first, so it is not left alive and unreferenced.
    if (storedSubId && storedSubId !== subscriptionId && !stored.live && stored.status) {
      // Also for an already-terminal early status: the guard re-reads the payment state, and a bank payment
      // still processing on it parks the checkout instead of applying it (it may yet settle).
      await this.cancelSupersededUnlessProcessing(
        session,
        tenantId,
        stripeSub,
        existingOverride,
        storedSubId,
      );
    }
    /** Re-judged under the tenant row lock, from the row as it is NOW (a racing completion or a manual
     *  activation may have committed since the read above). A moved stored id is a retryable conflict. */
    const recheckUnderLock = async (tx: Prisma.TransactionClient): Promise<void> => {
      const current = await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: { stripeSubId: true, externalPayment: true },
      });
      const now = current?.stripeSubId ?? null;
      // A racing delivery of THIS SAME session may have stored its own subscription since the read above:
      // that is a redelivery, not a conflict — the writes below are idempotent and judge nothing new.
      if (now !== storedSubId && now !== subscriptionId) {
        throw new ConflictException(
          "The tenant's subscription changed while this checkout was being applied — the checkout is retried.",
        );
      }
      // The decisive marker read: AFTER the tenant row lock this transaction already holds, so a manual
      // activation that committed since the early read (it takes the same lock) is always visible.
      const manualAt =
        current?.externalPayment === true
          ? await this.latestManualActivationAt(tx, tenantId)
          : null;
      const verdict = this.judgeDuplicate(session, subscriptionId, current, storedLive, manualAt);
      if (verdict) throw new DuplicateCheckoutSignal(verdict);
    };

    // Lane B A2 / B593: the plan being LEFT is the stored subscription key, else the legacy
    // `Tenant.plan` (the same fallback every plan path uses). Only a checkout that names a plan can
    // move it; a replay of the same webhook resolves to the same rank -> the hook does nothing.
    // `prepare()` (the flag + catalog read) runs BEFORE the transaction, `onPlanChange` inside it.
    // Read ONLY while the snapshot flag is on: flag off, this handler issues exactly the queries it
    // did before the hook existed.
    // Every session, plan-naming or not: the tenant/customer/replay guards below protect the Stripe
    // ids + period write too, and a legacy session with no planKey used to skip all of them.
    const snapshotOn = await this.planTransition.isEnabled();
    const tenantRow = snapshotOn
      ? await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { plan: true, planVersionId: true },
        })
      : null;

    // ── Flag-ON guards (none of these run, or read anything, while the flag is off) ──────────────
    // The signature proves the Stripe account, not that RouteFlow created this session, and the
    // hook now snapshots/RESTORES config: a session for a tenant we do not know, or whose customer
    // is not the one we stored for that tenant, is refused before anything is written.
    // The STORED key is canonical (a legacy `metadata.plan` enum name -> its canonical key) only
    // while the snapshot flag is on — the same string the snapshot/audit rows carry, so it never
    // differs by cohort. Flag OFF the raw key is written exactly as before (byte-identical).
    let planKeyForCheckout =
      snapshotOn && resolvedPlanKey
        ? (normalizePlanKey(resolvedPlanKey) ?? resolvedPlanKey)
        : resolvedPlanKey;
    // P0 hotfix: THIS session's own subscription is already the stored one, so an earlier (unpaid) delivery of it linked
    // the plan and ran the plan-transition hook. Settling it must not re-judge the plan: the "newer downgrade" query
    // below would find that delivery's OWN snapshot (a false "plan not changed" email to the tenant admin), and a
    // re-write could reverse a change made while the debit was in flight. It only activates.
    const alreadyLinked = existingOverride?.stripeSubId === subscriptionId;
    if (snapshotOn) {
      const storedCustomer = existingOverride?.stripeCustomerId;
      if (!tenantRow || (storedCustomer && storedCustomer !== session.customer)) {
        this.logger.error(
          `checkout.session.completed REFUSED for tenant ${tenantId}: ` +
            (tenantRow ? "customer does not match the tenant's Stripe customer" : "unknown tenant"),
        );
        // Stripe gets a 200 (there is nothing to retry), so the refusal must leave a findable trail,
        // not only a log line. tenantId is the METADATA's claim, so an unknown tenant is stored null.
        await this.recordCheckoutRefusal(session, tenantRow ? tenantId : null, {
          reason: tenantRow ? "customer_mismatch" : "unknown_tenant",
          requestedPlanKey: resolvedPlanKey,
          ...this.checkoutCustomerTrail(session, existingOverride, stripeSub),
        });
        return;
      }
      if (typeof session.created === "number" && !alreadyLinked) {
        // A downgrade that committed AFTER this session was created is the tenant's (or an admin's)
        // newer decision: an out-of-order/redelivered checkout must not reverse it. The Stripe ids
        // and period still land (money moved); only the PLAN change is skipped.
        const newerDowngrade = await this.prisma.tenantFeatureConfigSnapshot.findFirst({
          where: {
            tenantId,
            reason: "DOWNGRADE",
            takenAt: { gt: new Date(session.created * 1000) },
          },
          select: { id: true },
        });
        if (newerDowngrade) {
          this.logger.warn(
            `checkout.session.completed ${session.id}: tenant ${tenantId} downgraded after this ` +
              `session was created — recording Stripe ids/period but NOT changing the plan`,
          );
          planKeyForCheckout = null;
          await this.prisma.auditLog
            .create({
              data: {
                tenantId,
                action: STRIPE_CHECKOUT_STALE_ACTION,
                entityType: STRIPE_CHECKOUT_ENTITY,
                entityId: session.id ?? null,
                meta: { requestedPlanKey: resolvedPlanKey },
              },
            })
            .catch(() => undefined);
          // Money was taken but the plan was NOT changed: tell the tenant's admin(s) (idempotent per
          // session; never throws) instead of a silent 200 to Stripe.
          if (resolvedPlanKey && session.id) {
            await this.billingNotification.notifyCheckoutPlanNotApplied(
              tenantId,
              resolvedPlanKey,
              session.id,
            );
          }
        }
      }
    }

    if (alreadyLinked) planKeyForCheckout = null; // linked (plan, base price) at the first delivery: never re-written

    const transition =
      planKeyForCheckout && tenantRow
        ? {
            tenantId,
            fromPlanKey:
              normalizePlanKey(existingOverride?.planKey) ?? planKeyFromEnum(tenantRow.plan),
            // Canonical key (metadata.plan can be a legacy enum name): the snapshot and audit rows
            // store this string, so it must not differ by cohort.
            toPlanKey: planKeyForCheckout,
            toPlanVersionId: tenantRow.planVersionId ?? null,
            actor: { id: null, name: "system: stripe checkout" },
          }
        : null;
    const preparedTransition = transition ? await this.planTransition.prepare(transition) : null;

    const upsertArgs = {
      where: { tenantId },
      create: {
        tenantId,
        stripeCustomerId: session.customer as string,
        stripeSubId: subscriptionId,
        // The plan KEY resolved from the session, never the skipped/stale one: when the plan
        // change is skipped `planKeyForCheckout` is null and this would otherwise fall back to a
        // raw `metadata.plan` cast to the enum — a plan-key value is a Prisma enum reject (500 loop).
        currentPlan: resolvedPlanKey
          ? planKeyToEnum(resolvedPlanKey)
          : ((session.metadata?.plan as TenantPlan) ?? "STARTER"),
        planKey: planKeyForCheckout,
        basePriceSnapshot: resolvedBasePrice,
        ...(period ?? {}),
        billingInterval,
      },
      update: {
        stripeSubId: subscriptionId,
        stripeCustomerId: session.customer as string,
        ...(period ?? {}),
        ...(billingInterval ? { billingInterval } : {}),
        // SA-733 D7 / b2b review: a CATCH-UP checkout turns manual invoicing off HERE, in the apply transaction and
        // BEFORE the trailing coupon sync (coupon-state forces couponFull=false on an externalPayment row). Nothing
        // else on this base clears externalPayment on a card checkout.
        ...(isCatchupSession(session) ? { externalPayment: false } : {}),
        ...(planKeyForCheckout ? { planKey: planKeyForCheckout } : {}),
        ...(planKeyForCheckout && resolvedBasePrice != null && !hasNegotiatedOverride
          ? { basePriceSnapshot: resolvedBasePrice }
          : {}),
      },
    };

    // Flag OFF (or a checkout that names no plan): EXACTLY the plain upsert this handler always
    // did — no transaction, no hook. Only an active hook wraps it, so it commits with the snapshot.
    let upserted: any;
    try {
      if (transition && preparedTransition?.enabled) {
        try {
          // #2560 / SA-508: a lock conflict (40P01/40001) is retried in-process — the advisory lock
          // and the in-tx "already applied" check make a re-run idempotent; one that persists past the
          // budget still rethrows below and Stripe redelivers.
          upserted = await retryOnTxConflict("billing.onCheckoutCompleted", () =>
            this.prisma.$transaction(
              async (tx) => {
                // One processor per checkout session at a time (the audit row below has no unique
                // index, and adding one is a migration): a concurrent redelivery waits here, then sees
                // the winner's committed row and does nothing.
                if (session.id) {
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stripe-checkout"}), hashtext(${session.id}))`;
                  const done = await tx.auditLog.findFirst({
                    where: {
                      tenantId,
                      entityType: STRIPE_CHECKOUT_ENTITY,
                      entityId: session.id,
                      action: STRIPE_CHECKOUT_APPLIED_ACTION,
                    },
                    select: { id: true },
                  });
                  if (done) return ALREADY_APPLIED;
                }
                // A snapshot failure (a DOWNGRADE) throws -> the handler fails -> Stripe redelivers,
                // so a downgrade is never applied without its snapshot (fail closed).
                await this.planTransition.onPlanChange(tx, transition, preparedTransition);
                // #2560 / SA-508: the house order — the Tenant row lock right after the hook, before the
                // subscription writes and the AuditLog insert (its Tenant FK takes KEY SHARE).
                await lockTenantForLedger(tx, tenantId);
                // X1: judged again under the lock; a duplicate throws, so the hook's writes above roll back.
                await recheckUnderLock(tx);
                const previousSubId = await this.storedStripeSubIdTx(tx, tenantId);
                // Compare-and-swap on the plan we judged the transition from (the same shape as
                // upgrade()'s guard): if an in-app change moved it since we read it, this checkout is
                // stale — throw so the tx (hook writes included) rolls back and Stripe redelivers,
                // instead of silently reversing the newer change.
                if (existingOverride) {
                  const held = await tx.tenantSubscription.updateMany({
                    // ...and on the subscription id we judged the duplicate question from.
                    where: {
                      tenantId,
                      planKey: existingOverride.planKey ?? null,
                      stripeSubId: storedSubId,
                    },
                    data: { stripeSubId: subscriptionId },
                  });
                  if (held.count === 0) {
                    throw new ConflictException(
                      "Plan changed concurrently — the checkout is retried.",
                    );
                  }
                }
                const row = await tx.tenantSubscription.upsert(upsertArgs);
                await this.resetCouponIfSubReplacedTx(tx, tenantId, previousSubId, subscriptionId);
                // P0 hotfix: only a SETTLED session leaves the marker (an unpaid bank debit is linked, not applied)
                if (session.id && settled) {
                  await this.writeAppliedMarker(tx, tenantId, session.id, {
                    fromPlanKey: transition.fromPlanKey,
                    toPlanKey: transition.toPlanKey,
                  });
                }
                return row;
              },
              // Explicit, bounded budget — see CHECKOUT_TX_OPTIONS for why these numbers.
              CHECKOUT_TX_OPTIONS,
            ),
          );
        } catch (err) {
          if (
            !(err instanceof ConflictException) &&
            !(err instanceof DuplicateCheckoutSignal) &&
            !isDeadlockOrSerialization(err)
          ) {
            // A paid checkout the hook/transaction cannot process (anything but the retryable CAS
            // conflict) can fail every redelivery the same way until Stripe gives up after days:
            // leave an audit row so it is findable, not just a log line.
            this.logger.error(
              `PAID checkout ${session.id ?? "?"} blocked by the plan-transition hook: ${(err as Error).message}`,
            );
            await this.prisma.auditLog
              .create({
                data: {
                  tenantId,
                  action: STRIPE_CHECKOUT_HOOK_FAILED_ACTION,
                  entityType: STRIPE_CHECKOUT_ENTITY,
                  entityId: session.id ?? null,
                  // name + Prisma code only: a raw message can carry SQL/row fragments.
                  meta: {
                    toPlanKey: transition.toPlanKey,
                    errorName: (err as Error)?.name ?? null,
                    code: (err as { code?: string })?.code ?? null,
                  },
                },
              })
              .catch(() => undefined);
          }
          throw err;
        }
        // Committed: an automatic restore may have rewritten the tenant's feature rows, so drop the
        // 30 s resolver/override/config caches. A redelivery that did nothing has nothing to drop.
        if (upserted !== ALREADY_APPLIED) {
          this.planTransition.invalidateCaches(tenantId, preparedTransition);
        }
      } else {
        // Flag OFF (or a checkout that names no plan / a stale one): no plan-transition hook, but the same
        // per-session lock first, then the tenant row lock (the hook path's order) and the same under-the-lock duplicate re-check as
        // the hook path, so a racing completion or manual activation can never be overwritten.
        upserted = await retryOnTxConflict("billing.onCheckoutCompleted", () =>
          this.prisma.$transaction(async (tx) => {
            // B1157: this path writes the APPLIED marker too (so the paid-but-cancelled notice can tell an
            // applied session from a never-applied one), under the same one-processor-per-session lock.
            if (session.id) {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stripe-checkout"}), hashtext(${session.id}))`;
              if (await this.hasAppliedMarker(tenantId, session.id, tx)) return ALREADY_APPLIED;
            }
            await lockTenantForLedger(tx, tenantId);
            await recheckUnderLock(tx);
            const previousSubId = await this.storedStripeSubIdTx(tx, tenantId);
            const row = await tx.tenantSubscription.upsert(upsertArgs);
            await this.resetCouponIfSubReplacedTx(tx, tenantId, previousSubId, subscriptionId);
            if (session.id && settled) {
              await this.writeAppliedMarker(tx, tenantId, session.id, {
                toPlanKey: planKeyForCheckout ?? resolvedPlanKey,
                subscriptionId,
              });
            }
            return row;
          }, CHECKOUT_TX_OPTIONS),
        );
      }
    } catch (err) {
      // X1: the under-the-lock re-check found a duplicate (a racing completion or a manual activation
      // committed after the early judgement): the transaction rolled back, nothing was written.
      if (err instanceof DuplicateCheckoutSignal) {
        await this.handleDuplicate(session, tenantId, stripeSub, err.verdict);
        return;
      }
      throw err;
    }

    if (upserted === ALREADY_APPLIED) {
      this.logger.log(`checkout.session.completed ${session.id} already applied — ignoring`);
      // a racing delivery applied it: what the tenant stores is read FRESH (it may have moved on since)
      const nowStored = await this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: { stripeSubId: true },
      });
      await this.adoptOntoCurrentSubscription(
        tenantId,
        subscriptionId,
        nowStored?.stripeSubId ?? null,
        stripeSub,
        adoptCtx,
      );
      // SA-736r F2: a redelivery that finds the session applied STILL syncs the coupon (idempotent), so a
      // sync that threw after the upsert is retried instead of being lost behind ALREADY_APPLIED.
      await this.syncCoupon(tenantId, subscriptionId, "checkout_completed");
      return;
    }

    if (!settled) {
      // A bank debit in flight: linked above, NOT activated. It activates (once) when
      // checkout.session.async_payment_succeeded re-delivers this session as `paid`; a failed debit leaves a notice
      // row instead (onCheckoutAsyncPaymentFailed). No marker was written, so that delivery is not "already applied".
      this.logger.log(
        `checkout.awaiting_async_payment ${session.id ?? "?"}: tenant ${tenantId} linked to ${subscriptionId} ` +
          `(payment_status=${session.payment_status ?? "unknown"}) - NOT activated until the payment settles`,
      );
      return;
    }

    // Atomic non-ACTIVE→ACTIVE: activates the tenant, and if it was previously non-paying (e.g.
    // SUSPENDED) re-adds its run-rate exactly once — idempotent against the paired
    // invoice.payment_succeeded webhook. NO-OP for a fresh Stripe checkout (planKey is null —
    // legacy Stripe doesn't set it, so emitPayingDelta short-circuits).
    const reinstated = await this.transitionAndEmit(
      tenantId,
      { status: { not: "ACTIVE" } },
      "ACTIVE",
      1,
      BILLING_EVENTS.SUBSCRIPTION_RESUMED,
      { source: "stripe", reason: "checkout_completed", ...scheduleLeftArmed(upserted) },
    );
    this.tenantStatusGuard.invalidate(tenantId);

    // B216: this reinstatement does NOT touch the tenant's scheduled downgrade — see
    // scheduleLeftArmed(). The ledger event above carries it, but emitPayingDelta short-circuits
    // when planKey is null (the legacy Stripe cohort, which is exactly the cohort most likely to
    // be here), so no event exists for those tenants and this log line is then the only record.
    if (reinstated && upserted.downgradeToPlanKey) {
      this.logger.log(
        `B216: checkout reinstatement left tenant ${tenantId}'s scheduled downgrade to ` +
          `${upserted.downgradeToPlanKey} ARMED (effective ` +
          `${upserted.downgradeEffectiveAt?.toISOString() ?? "unset"}) — applyScheduledDowngrades ` +
          `applies it when due`,
      );
    }

    // SA-690 option A, booked AFTER the activation crossing above. The crossing prices the base plan
    // and every active BILLABLE add-on (a comp is never revenue) at its STORED snapshot: 0 for a trial's
    // unbilled add-on, the old price for a row whose pointer is still on a dead subscription's item.
    // Adoption then books each add-on's one stored → actual delta (and swaps a stale pointer), so the
    // two sum to what Stripe bills. Reversed, the crossing would price the adopted snapshot a second
    // time.
    await this.mutations.adoptCheckoutAddons(tenantId, stripeSub, adoptCtx);

    // SA-736r M3: LAST, after the activation crossing and the add-on adoption (their writes are
    // idempotent), so a throwing sync is retried by Stripe without double-booking anything.
    await this.syncCoupon(tenantId, subscriptionId, "checkout_completed");

    this.logger.log(`Tenant ${tenantId} activated via checkout (sub: ${subscriptionId})`);
  }

  /** #2440: the Stripe subscription item ids of the tenant's add-ons (never the base plan). */
  private async addonItemIds(tenantId: string): Promise<Set<string>> {
    const addons = await this.prisma.tenantAddon.findMany({
      where: { tenantId, stripeItemId: { not: null } },
      select: { stripeItemId: true },
    });
    return new Set(addons.map((a) => a.stripeItemId).filter((id): id is string => id != null));
  }

  /**
   * #2436/#2440: a Stripe subscription's current period, read from its base-plan item (never one
   * of the tenant's known add-on items — N2). A null period writes nothing, but is logged (N1): a
   * null periodEnd silently hides the tenant from suspendOverdueTenants.
   */
  private async subscriptionPeriod(
    stripeSub: any,
    tenantId: string,
    event: string,
    extraAddonItemIds: readonly string[] = [],
  ): Promise<{ periodStart: Date; periodEnd: Date } | null> {
    const known = await this.addonItemIds(tenantId);
    for (const id of extraAddonItemIds) known.add(id);
    const period = stripeSubscriptionPeriod(stripeSub, known);
    if (!period) {
      this.logger.warn(
        `${event}: Stripe subscription ${stripeSub?.id ?? "(unknown)"} for tenant ${tenantId} ` +
          `has no billing period — period not written`,
      );
    }
    return period;
  }

  private async onPaymentSucceeded(invoice: any): Promise<void> {
    const customerId =
      typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

    if (!customerId) return;

    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { stripeCustomerId: customerId },
      // R2: the tenant's CURRENT status is what decides whether the cancelAtPeriodEnd guard
      // below applies — onPaymentFailed already includes the tenant the same way.
      include: { tenant: { select: { status: true, readOnlyReason: true } } },
    });
    if (!sub) {
      this.logger.debug(
        `No tenant found for Stripe customer ${customerId} (invoice.payment_succeeded)`,
      );
      return;
    }

    // #2440: a paid invoice ends the dunning run — reset the count onPaymentFailed raises. Only a
    // row that actually failed is written (a free pilot's count is 0, so it is never touched).
    if (sub.failedPaymentCount > 0) {
      await this.prisma.tenantSubscription.update({
        where: { tenantId: sub.tenantId },
        data: { failedPaymentCount: 0 },
      });
    }

    // Fetch the subscription to update period dates
    if (sub.stripeSubId) {
      try {
        const stripeSub = await this.stripe.getSubscription(sub.stripeSubId);
        const period = await this.subscriptionPeriod(
          stripeSub,
          sub.tenantId,
          "invoice.payment_succeeded",
        );
        if (period) {
          await this.prisma.tenantSubscription.update({
            where: { tenantId: sub.tenantId },
            data: period,
          });
        }
      } catch {
        // Best-effort period update
      }
    }

    // STRIPE-CANCEL-1: a tenant who self-serve cancelled has cancelAtPeriodEnd armed locally.
    // Reinstating here on the next invoice.payment_succeeded would resurrect them to ACTIVE
    // without ever checking whether Stripe actually stopped billing — the exact defect (our
    // cron takes them READ_ONLY at period end, then this handler flips them back ACTIVE every
    // cycle while Stripe keeps charging).
    //
    // R2 (Opus F3): narrowed to EXECUTED cancellations only — READ_ONLY (the cancellation
    // already took effect) or CANCELLED (terminal). Any OTHER status, chiefly SUSPENDED, falls
    // through to the reinstatement below exactly as before this fix: a SUSPENDED (past-due)
    // tenant who scheduled a cancellation and then PAYS the past-due invoice paid for that
    // period and must be reinstated — nothing else moves them out of SUSPENDED
    // (applyScheduledCancellations only ever looks at ACTIVE tenants). The flag stays armed;
    // cancel() (Stripe-first) has already told Stripe, which ends the subscription at period
    // end via onSubscriptionDeleted.
    if (
      sub.cancelAtPeriodEnd &&
      (sub.tenant.status === "READ_ONLY" || sub.tenant.status === "CANCELLED")
    ) {
      this.logger.warn(
        `STRIPE-CANCEL-1: invoice.payment_succeeded for tenant ${sub.tenantId} while cancelAtPeriodEnd is armed and tenant.status is ${sub.tenant.status} (stripeSubId ${sub.stripeSubId ?? "none"}) — not reinstating; the provider subscription was not cancelled at period end. Needs manual reconciliation.`,
      );
      return;
    }

    // SA-733r3 N1 (r4 #1 text): the legacy reinstatement needs the invoice's subscription to EQUAL the row's NON-NULL
    // stripeSubId (dahlia has no `invoice.subscription`; the id lives where stripeInvoiceSubscriptionId reads it).
    // Customer-wide matching let a late payment on an old / other subscription (or a one-off invoice) reinstate a
    // SUSPENDED or lapsed-trial tenant, book +MRR and wipe a live dunning clock. The count reset above still applies.
    const invoiceSubId = stripeInvoiceSubscriptionId(invoice);
    if (!sub.stripeSubId || invoiceSubId !== sub.stripeSubId) {
      this.logger.log(
        `payment_succeeded for tenant ${sub.tenantId}: invoice subscription ${invoiceSubId ?? "none"} is not the tenant's own - no reinstatement`,
      );
      return;
    }

    // SA-733r M3 / r3 N1 (PR-B3): a dunning pause is resumed ONLY by invoice.paid (DunningService.onInvoicePaid,
    // which books the single +MRR and clears the clock), and a paid invoice never revives a CANCELLED paused tenant
    // for free. Customer-wide `payment_succeeded` for either reason therefore reinstates nothing.
    if (
      sub.tenant?.status === "READ_ONLY" &&
      (sub.tenant.readOnlyReason === "payment_overdue" ||
        sub.tenant.readOnlyReason === "subscription_cancelled")
    ) {
      this.logger.log(
        `payment_succeeded for tenant ${sub.tenantId}: READ_ONLY(${sub.tenant.readOnlyReason}) is not reinstated here`,
      );
      return;
    }

    // Atomic non-ACTIVE→ACTIVE: reinstates a dropped-out tenant and re-adds its run-rate exactly
    // once. The conditional flip is the idempotency key — the paired checkout.session.completed
    // webhook races here and only the winner emits — and it is a NO-OP on ordinary renewals
    // (already ACTIVE → count 0 → no ledger delta).
    const reinstated = await this.transitionAndEmit(
      sub.tenantId,
      { status: { not: "ACTIVE" } },
      "ACTIVE",
      1,
      BILLING_EVENTS.SUBSCRIPTION_RESUMED,
      { source: "stripe", reason: "payment_succeeded", ...scheduleLeftArmed(sub) },
    );
    this.tenantStatusGuard.invalidate(sub.tenantId);

    // B216: see onCheckoutCompleted — paying an invoice settles a debt, it does not re-choose a
    // plan, so the tenant's scheduled downgrade is left armed and recorded rather than cleared.
    if (reinstated && sub.downgradeToPlanKey) {
      this.logger.log(
        `B216: payment reinstatement left tenant ${sub.tenantId}'s scheduled downgrade to ` +
          `${sub.downgradeToPlanKey} ARMED (effective ` +
          `${sub.downgradeEffectiveAt?.toISOString() ?? "unset"}) — applyScheduledDowngrades ` +
          `applies it when due`,
      );
    }

    // SA-736r F1: LAST - catches a repeating coupon that ended at the period boundary. Every earlier write
    // here is idempotent (CAS resume, absolute reset), so a throwing sync is safely retried.
    if (sub.stripeSubId) await this.syncCoupon(sub.tenantId, sub.stripeSubId, "payment_succeeded");

    this.logger.log(`Payment succeeded for tenant ${sub.tenantId} (customer ${customerId})`);
  }

  /**
   * #2440 (SA-450): the local subscription row a Stripe subscription or invoice event belongs to,
   * matched by the subscription id AND its customer — never customer-wide. A missing id, no row, or
   * a row whose customer differs is logged and returns null, and the caller writes nothing. Free
   * pilots have no stripeSubId, so they never match.
   */
  private async matchStripeSubscription(
    subscriptionId: string | null,
    customer: unknown,
    event: string,
  ) {
    if (!subscriptionId) return null;
    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { stripeSubId: subscriptionId },
      include: { tenant: { select: { id: true, slug: true, name: true } } },
    });
    const customerId = stripeRefId(customer);
    if (
      !sub ||
      sub.stripeSubId !== subscriptionId ||
      !customerId ||
      sub.stripeCustomerId !== customerId
    ) {
      this.logger.warn(
        `#2440: ${event} for subscription ${subscriptionId} (customer ${customerId ?? "none"}) ` +
          `matched no tenant subscription — ignored`,
      );
      return null;
    }
    return sub;
  }

  /**
   * R1 option B: Stripe announces the renewal days ahead. If the tenant has a scheduled downgrade, its price is
   * pushed NOW, before the invoice is cut. The event rides the existing StripeBillingEvent ledger (a redelivery of
   * the same event id never reaches here twice) and the push itself is idempotent (Stripe already billing the
   * target is a no-op). A lock collision or an unreadable Stripe THROWS: the webhook fails and Stripe redelivers,
   * never a double push. A REFUSAL (an annual item, an unresolvable price) is alerted and acknowledged - a
   * redelivery could never succeed.
   */
  private async onInvoiceUpcoming(invoice: any): Promise<void> {
    if (!this.scheduledPrice) return;
    const sub = await this.matchStripeSubscription(
      stripeInvoiceSubscriptionId(invoice),
      invoice?.customer,
      "invoice.upcoming",
    );
    if (!sub) return;
    try {
      const out = await this.scheduledPrice.apply(sub.tenantId);
      if (out.applied) {
        this.logger.log(
          `invoice.upcoming: scheduled downgrade price pushed for tenant ${sub.tenantId} (${out.priorAmountCents} -> ${out.amountCents} cents)`,
        );
      }
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      this.logger.error(
        `invoice.upcoming: the scheduled downgrade price for tenant ${sub.tenantId} cannot be applied - fix it in Stripe before the renewal: ${err.message}`,
      );
    }
  }

  private async onPaymentFailed(invoice: any): Promise<void> {
    const sub = await this.matchStripeSubscription(
      stripeInvoiceSubscriptionId(invoice),
      invoice?.customer,
      "invoice.payment_failed",
    );
    if (!sub) return;

    // SA-736r M3/F1: a failing invoice means the coupon no longer zeroes it. The sync runs BEFORE the
    // non-idempotent increment below: a throwing sync aborts here, before the count moves, and the redelivery
    // runs the whole handler once.
    try {
      await this.syncCoupon(sub.tenantId, sub.stripeSubId as string, "payment_failed");
    } catch (err) {
      // Rethrown (Stripe redelivers, and the count has not moved), but never silently: a PERSISTENT Stripe
      // error here would keep failedPaymentCount from ever advancing, so it is an ERROR with the tenant id.
      this.logger.error(
        `payment_failed for tenant ${sub.tenantId}: the coupon sync failed, so the failed-payment count did not advance (${(err as Error)?.message}); Stripe will redeliver`,
      );
      throw err;
    }

    // SA-733r7 PR-B3: the dunning clock is stamped once per invoice (in enforced the d0 notice goes out; in off/dark
    // master's direct email below is the only tenant email). BEFORE the non-idempotent increment below, like the coupon sync: a throw here (an unreadable
    // Stripe) aborts before the count moves and the redelivery runs the whole handler once.
    await this.dunning?.onPaymentFailed(invoice);

    // Dunning is counted, not enforced here: no status change. The pause belongs to DunningService's hourly sweep;
    // reinstatement stays with payment_succeeded (which resets this count) and invoice.paid (the dunning resume).
    await this.prisma.tenantSubscription.update({
      where: { tenantId: sub.tenantId },
      data: { failedPaymentCount: { increment: 1 } },
    });

    this.logger.warn(
      `Payment failed for tenant ${sub.tenantId} (${sub.tenant.slug}). Grace period: ${PAYMENT_GRACE_DAYS} days.`,
    );

    // SA r-note 5 A1: in off/dark this is the ONLY tenant email (master's #2440, one per real payment_failed: dark
    // is silent to tenants); the dunning milestone series replaces it in enforced. #2476 / SA-472: the increment
    // above IS the event's effect, so everything after it is best-effort and never throws - a throw would record
    // "error:" and make a redelivery re-run the increment.
    const mode = billingPauseMode();
    if (dunningEmailsFor(mode) === "legacy_failed_payment") {
      try {
        await this.sendPaymentFailedEmail(sub);
      } catch (e) {
        this.logger.warn(
          `payment-failed email for tenant ${sub.tenantId} not sent: ${(e as Error)?.message}`,
        );
      }
    }
  }

  /** The admin warning for a failed payment (#2440): portal link best-effort, plain-text fallback. */
  private async sendPaymentFailedEmail(sub: {
    tenantId: string;
    tenant: { slug: string; name: string | null };
  }): Promise<void> {
    const adminUser = await this.prisma.user.findFirst({
      where: { tenantId: sub.tenantId, role: "TENANT_ADMIN", deletedAt: null },
      select: { email: true, username: true },
    });
    if (!adminUser?.email) return;
    // Best-effort billing-portal link; any portal error (or a non-http(s) URL, which
    // safeLinkHref refuses) falls back to today's plain text.
    const href = safeLinkHref(await this.portalUrlOrEmpty(sub.tenantId), "onPaymentFailed");
    const updateLine = href
      ? `<p><a href="${escapeHtml(href)}">Update your payment method in the billing portal</a>.</p>`
      : `<p>You can update your payment details by contacting support or visiting your billing portal.</p>`;
    await this.email.send({
      to: adminUser.email,
      subject: `Payment failed — ${sub.tenant.name ?? sub.tenant.slug}`,
      html: `<p>Hello ${escapeHtml(adminUser.username)},</p>
<p>We were unable to process your subscription payment for <strong>${escapeHtml(sub.tenant.name ?? sub.tenant.slug)}</strong>.</p>
<p>Please update your payment method to avoid service interruption.</p>
${updateLine}
<p>RouteFlow Platform</p>`,
    });
  }

  /** #2440: the tenant's billing-portal URL, or "" on any portal error (logged, never thrown). */
  private async portalUrlOrEmpty(tenantId: string): Promise<string> {
    try {
      // #2476: capped - this runs inside the webhook's claim lease, and the link is best-effort.
      return (
        await this.createBillingPortalSession(tenantId, undefined, PAYMENT_FAILED_PORTAL_REQUEST)
      ).portalUrl;
    } catch (e) {
      this.logger.warn(
        `Billing portal link unavailable for tenant ${tenantId}: ${(e as Error).message}`,
      );
      return "";
    }
  }

  private async onSubscriptionDeleted(subscription: any): Promise<void> {
    const sub = await this.matchStripeSubscription(
      stripeRefId(subscription?.id),
      subscription?.customer,
      "customer.subscription.deleted",
    );
    if (!sub) return;
    await this.cancelFromStripe(sub, "subscription_deleted");
  }

  /**
   * #2440 (SA-450): Stripe ended the subscription (deleted, or updated to `canceled`).
   * ACTIVE → CANCELLED books the −MRR churn delta once (transitionAndEmit's CAS). SUSPENDED →
   * CANCELLED is a plain CAS with NO delta: the suspension (overdue cron or platform admin)
   * already removed the run-rate. TRIAL and READ_ONLY are never forced to CANCELLED, and a
   * repeat webhook finds CANCELLED, loses both CASes and writes nothing.
   */
  private async cancelFromStripe(
    sub: {
      tenantId: string;
      planKey: string | null;
      basePriceSnapshot: Prisma.Decimal | null;
      discount: Prisma.Decimal | null;
    },
    reason: string,
  ): Promise<void> {
    const churned = await this.transitionAndEmit(
      sub.tenantId,
      { status: "ACTIVE" },
      "CANCELLED",
      -1,
      BILLING_EVENTS.SUBSCRIPTION_CANCELED,
      { source: "stripe", reason },
    );
    const cancelled =
      churned ||
      (
        await this.prisma.tenant.updateMany({
          where: { id: sub.tenantId, status: "SUSPENDED" },
          data: { status: "CANCELLED" },
        })
      ).count === 1;
    if (!cancelled) {
      // SA-733r2 N1: a PAUSED tenant whose Stripe subscription ended lands on READ_ONLY(subscription_cancelled),
      // never CANCELLED; the overdue invoice stays owed. (A no-op for every other status.)
      await this.dunning?.markCancelledWhilePaused(sub.tenantId);
      // SA-736r M5/F5: the status CAS missed (TRIAL / READ_ONLY / already CANCELLED), the columns still reset.
      await resetCouponState(
        { prisma: this.prisma, events: this.events },
        sub.tenantId,
        `stripe_${reason}`,
      );
      this.logger.log(
        `Stripe ${reason} for tenant ${sub.tenantId}: status is not ACTIVE/SUSPENDED — left as is`,
      );
      return;
    }
    this.tenantStatusGuard.invalidate(sub.tenantId);

    // A cancellation SUPERSEDES any scheduled downgrade — the same rule the self-service
    // cancel() applies (subscription-mutation.service.ts). Left armed, the 02:00 sweep would
    // re-price basePriceSnapshot on an already-churned tenant and book a second MRR delta.
    await this.prisma.tenantSubscription.update({
      where: { tenantId: sub.tenantId },
      data: { cancelAtPeriodEnd: true, ...disarmedDowngrade() },
    });

    // SA-736r M5: the coupon columns never outlive their subscription - reset AFTER the cancel flag and the
    // downgrade disarm are written (own tx, Tenant lock first). The status CAS above already ran, so cancelling
    // a couponFull tenant books 0.
    await resetCouponState(
      { prisma: this.prisma, events: this.events },
      sub.tenantId,
      `stripe_${reason}`,
    );

    this.logger.log(`Subscription cancelled for tenant ${sub.tenantId} (${reason})`);

    // N3: best-effort admin notification, never blocks the cancellation above (a Stripe
    // webhook retry is deduped by BillingNotificationService's own idempotency claim).
    // BillingNotificationService never throws by contract — this try/catch is defense in
    // depth so a future change there can never turn a webhook 500 into a lost cancellation.
    try {
      await this.billingNotification.notifyCancelled(sub.tenantId);
    } catch (e) {
      this.logger.error(
        `N3 notifyCancelled threw unexpectedly for tenant ${sub.tenantId}`,
        e as Error,
      );
    }
  }

  private async onSubscriptionUpdated(subscription: any): Promise<void> {
    const sub = await this.matchStripeSubscription(
      stripeRefId(subscription?.id),
      subscription?.customer,
      "customer.subscription.updated",
    );
    if (!sub) return;

    // Update period dates and cancellation flag. The downgrade markers are cleared ONLY when
    // this event ARMS a cancellation (a cancellation supersedes a scheduled downgrade, as
    // cancel() rules): clearing them on every update would let an unrelated Stripe write (a
    // cycle roll, a price sync, an add-on item) silently drop a schedule the tenant made here.
    const period = await this.subscriptionPeriod(
      subscription,
      sub.tenantId,
      "customer.subscription.updated",
    );
    await this.prisma.tenantSubscription.update({
      where: { tenantId: sub.tenantId },
      data: {
        // #2436: items under dahlia, the top level for an older endpoint version; none ⇒ no write.
        ...(period ?? {}),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        ...(subscription.cancel_at_period_end === true ? disarmedDowngrade() : {}),
      },
    });

    this.logger.debug(
      `Subscription updated for tenant ${sub.tenantId} — cancel_at_period_end: ${subscription.cancel_at_period_end}`,
    );

    // #2440 (SA-450): only `canceled` maps to a status (as deleted). past_due / unpaid write none —
    // grace stays with suspendOverdueTenants, reinstatement with invoice.payment_succeeded.
    if (subscription.status === "canceled") {
      await this.cancelFromStripe(sub, "subscription_canceled");
      return; // SA-736r M1: a canceled status skips the coupon sync - cancelFromStripe resets the columns
    }
    // SA-736r M3: adding or removing a discount fires this event; re-derive from Stripe, not the payload.
    await this.syncCoupon(sub.tenantId, sub.stripeSubId as string, "subscription_updated");
  }

  // ─── Cron: suspend tenants with expired trials / overdue payments ─────────

  /**
   * Runs every hour. Suspends tenants whose Stripe subscription was canceled (A2: never for past_due / unpaid):
   *  1. Are in TRIAL status with trialEndsAt in the past, OR
   *  2. Have a subscription whose periodEnd is past + grace period and still ACTIVE
   */
  @LeaderCron(CronExpression.EVERY_HOUR, "billing.suspendOverdueTenants")
  async suspendOverdueTenants(): Promise<void> {
    if (!this.stripe.isConfigured) return; // No billing = no suspension logic

    const now = new Date();
    const graceDeadline = new Date(now.getTime() - PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000);

    // Trial expiry is owned by BillingCronService.expireTrials() → READ_ONLY (not
    // SUSPENDED), so exports + sign-in keep working. This cron only handles overdue
    // Stripe payments below.

    // Overdue subscriptions (periodEnd + grace past, still ACTIVE, no recent payment)
    const overdueSubs = await this.prisma.tenantSubscription.findMany({
      where: {
        periodEnd: { lt: graceDeadline },
        stripeSubId: { not: null },
        tenant: { status: "ACTIVE", deletedAt: null },
      },
      include: { tenant: { select: { id: true, slug: true } } },
    });

    for (const sub of overdueSubs) {
      // Double-check with Stripe that the subscription is actually past-due or unpaid
      try {
        const stripeSub = await this.stripe.getSubscription(sub.stripeSubId!);
        // SA r-note 5 A2: ONLY `canceled` (a subscription the tenant ended). past_due / unpaid are payment-overdue
        // states and never suspend, in any BILLING_PAUSE_MODE: dunning owns non-payment (the 7-day grace, then
        // READ_ONLY + pay).
        if (stripeSub.status === "canceled") {
          // Atomic ACTIVE→SUSPENDED: emits the −MRR delta exactly once even if a concurrent
          // subscription.deleted webhook already churned this tenant (count 0 → no double). The
          // suspension is reversible — onPaymentSucceeded re-adds a matching +delta on reinstatement.
          const suspended = await this.transitionAndEmit(
            sub.tenantId,
            { status: "ACTIVE" },
            "SUSPENDED",
            -1,
            BILLING_EVENTS.SUBSCRIPTION_SUSPENDED,
            { source: "stripe", reason: "overdue_payment", stripeStatus: stripeSub.status },
          );
          if (suspended) {
            this.tenantStatusGuard.invalidate(sub.tenantId);
            this.logger.log(
              `Overdue payment — suspended tenant ${sub.tenant.slug} (Stripe status: ${stripeSub.status})`,
            );
            // N3: best-effort admin notification, never blocks the suspension above.
            try {
              await this.billingNotification.notifySuspended(
                sub.tenantId,
                SUSPENDED_REASON_SUBSCRIPTION_CANCELED,
              );
            } catch (e) {
              this.logger.error(
                `N3 notifySuspended threw unexpectedly for tenant ${sub.tenantId}`,
                e as Error,
              );
            }
          }
        }
      } catch (err) {
        this.logger.error(`Failed to check Stripe subscription for tenant ${sub.tenantId}`, err);
      }
    }

    if (overdueSubs.length > 0) {
      this.logger.log(`Suspension cron: ${overdueSubs.length} overdue subscriptions checked`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Get billing info for a tenant (used by platform admin). */
  async getTenantBillingInfo(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        plan: true,
        trialEndsAt: true,
      },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        plan: tenant.plan,
        trialEndsAt: tenant.trialEndsAt,
      },
      subscription: sub
        ? {
            stripeCustomerId: sub.stripeCustomerId,
            stripeSubId: sub.stripeSubId,
            currentPlan: sub.currentPlan,
            periodStart: sub.periodStart,
            periodEnd: sub.periodEnd,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          }
        : null,
      stripeConfigured: this.stripe.isConfigured,
    };
  }
}
