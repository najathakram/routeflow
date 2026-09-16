import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import { LeaderCron } from "../common/cron-lock";
import { Prisma, TenantPlan } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { roundMoney } from "@routeflow/pricing";
import { StripeService } from "./stripe.service";
import { BillingEventService } from "./billing-event.service";
import { PlatformPricingService } from "./platform-pricing.service";
import { BILLING_EVENTS, BillingEventType, planKeyToEnum } from "./plan-catalog.constants";

/** Grace period (in days) after a payment failure before suspending the tenant. */
const PAYMENT_GRACE_DAYS = 3;

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
  ) {}

  /**
   * Emit a signed MRR-ledger delta for a Stripe-driven status transition into (+1) or out of
   * (−1) the paying set, so the append-only BillingEvent ledger (and `ledgerMrr`/`momDelta`)
   * tracks the snapshot MRR across legacy-Stripe churn/reactivation.
   *
   * Mirrors MrrService's paying predicate: NO-OP when `planKey == null` (legacy Stripe-only
   * tenants never contribute to snapshot MRR, so there is no run-rate to move). Contribution =
   * `roundMoney(base + Σ active add-ons − discount)`.
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
    },
    direction: 1 | -1,
    event: BillingEventType,
    payload: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (sub.planKey == null) return; // wasn't in the paying set → no run-rate to move
    const addons = await tx.tenantAddon.findMany({
      where: { tenantId, active: true },
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
  private async transitionAndEmit(
    tenantId: string,
    sub: {
      planKey: string | null;
      basePriceSnapshot: Prisma.Decimal | null;
      discount: Prisma.Decimal | null;
    },
    statusWhere: Prisma.TenantWhereInput,
    toStatus: "ACTIVE" | "CANCELLED" | "SUSPENDED",
    direction: 1 | -1,
    event: BillingEventType,
    payload: Prisma.InputJsonValue,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.tenant.updateMany({
        where: { ...statusWhere, id: tenantId },
        // Reinstating to ACTIVE also clears a stale readOnlyReason (trial_cancelled /
        // trial_expired / subscription_cancelled) — RO-1 now ships that field to the client,
        // and a Stripe-driven reactivation is a paying tenant, never read-only.
        data: { status: toStatus, ...(toStatus === "ACTIVE" ? { readOnlyReason: null } : {}) },
      });
      if (count !== 1) return false;
      await this.emitPayingDelta(tenantId, sub, direction, event, payload, tx);
      return true;
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

    // Already has a Stripe customer?
    if (tenant.subscription?.stripeCustomerId) {
      return tenant.subscription.stripeCustomerId;
    }

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
    return customer.id;
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

    // A second checkout on a tenant that already has a live subscription creates a
    // SECOND Stripe subscription on the same customer: both invoice every cycle, and
    // the completion webhook overwrites `stripeSubId`, orphaning the first one where
    // nothing in RouteFlow can see (or cancel) it. Price changes never need a new
    // checkout — they ride the existing subscription via syncStripeSubscriptionPrice.
    const existingSub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { stripeSubId: true },
    });
    if (existingSub?.stripeSubId) {
      let liveStatus: string | undefined;
      try {
        liveStatus = (await this.stripe.getSubscription(existingSub.stripeSubId))?.status;
      } catch {
        // Stripe no longer knows this subscription (deleted / wrong account) — the
        // stored id is stale, so a fresh checkout is the correct recovery.
        liveStatus = undefined;
      }
      if (liveStatus && liveStatus !== "canceled" && liveStatus !== "incomplete_expired") {
        throw new BadRequestException(
          `Tenant already has a ${liveStatus} Stripe subscription (${existingSub.stripeSubId}). ` +
            `Change its price with the custom fee / plan price tools (applies at the next ` +
            `billing cycle) — creating another checkout would bill the tenant twice. Cancel ` +
            `the existing subscription first if you really need a new one.`,
        );
      }
    }

    const interval: "month" | "year" = opts?.interval === "year" ? "year" : "month";
    const customerId = await this.ensureStripeCustomer(tenantId);
    // Throws BadRequestException when neither an override nor a catalog price
    // exists for this tenant's plan (e.g. Enterprise with no custom fee yet).
    const pricing = await this.pricing.resolveTenantPricing(tenantId);
    const priceData = await this.pricing.checkoutPriceData(tenantId, interval);

    const baseUrl = process.env.FRONTEND_URL ?? "http://localhost:3001";

    // Inline price_data line item — bypasses StripeService.createCheckoutSession
    // (which only accepts a pre-created `priceId`) via the underlying client, since
    // no env-configured Stripe Price exists for catalog-driven plans/tiers.
    const session = await this.stripe.client.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price_data: priceData, quantity: 1 }],
      success_url:
        opts?.successUrl ?? `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: opts?.cancelUrl ?? `${baseUrl}/billing/cancel`,
      metadata: { tenantId, slug: tenant.slug, planKey: pricing.planKey, interval },
    });

    this.logger.log(
      `Checkout session ${session.id} created for tenant ${tenantId} (plan ${pricing.planKey}, ${interval})`,
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
   */
  async syncStripeSubscriptionPrice(tenantId: string): Promise<{
    synced: boolean;
    reason?: string;
    oldAmount?: number;
    newAmount?: number;
  }> {
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

    const result = await this.pushResolvedPriceToStripe(tenantId);
    // Reported MRR must follow the money: basePriceSnapshot is what MrrService prices
    // every paying tenant from, and Σ BillingEvent.amountDelta is what it reconciles
    // against — so a price change writes BOTH, whatever Stripe did.
    await this.reconcilePriceLedger(tenantId, pricing.monthly, pricing.planKey, result);
    return result;
  }

  /** The Stripe half of `syncStripeSubscriptionPrice` (no ledger side effects). */
  private async pushResolvedPriceToStripe(tenantId: string): Promise<{
    synced: boolean;
    reason?: string;
    oldAmount?: number;
    newAmount?: number;
  }> {
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

    if (stripeSub.status !== "active" && stripeSub.status !== "trialing") {
      return { synced: false, reason: `subscription_not_active_${stripeSub.status}` };
    }

    const item = stripeSub.items?.data?.[0];
    if (!item) {
      return { synced: false, reason: "no_subscription_item" };
    }

    const itemInterval = item.price?.recurring?.interval;
    const interval: "month" | "year" =
      itemInterval === "year" || itemInterval === "month"
        ? itemInterval
        : sub.billingInterval === "year"
          ? "year"
          : "month";

    const priceData = await this.pricing.checkoutPriceData(tenantId, interval);
    const oldAmount =
      typeof item.price?.unit_amount === "number" ? item.price.unit_amount / 100 : undefined;
    const newAmount = priceData.unit_amount / 100;

    // Stripe requires a `product` ID on inline price_data for a subscription-item
    // update — `product_data` is a Checkout-session-only shape and is REJECTED here
    // ("unknown parameter"), which would surface as a silent wrong-price. Reuse the
    // item's existing product when present, otherwise create one to point at.
    let productId: string | undefined =
      typeof item.price?.product === "string" ? item.price.product : item.price?.product?.id;
    if (!productId) {
      try {
        const product = await this.stripe.client.products.create({
          name: priceData.product_data.name,
        });
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

    try {
      await this.stripe.updateSubscription(sub.stripeSubId, {
        items: [{ id: item.id, price_data: updatePriceData }],
        proration_behavior: "none",
      });
    } catch (err) {
      this.logger.error(
        `Failed to sync Stripe subscription price for tenant ${tenantId}`,
        err as Error,
      );
      return { synced: false, reason: "stripe_update_failed" };
    }

    this.logger.log(
      `Synced Stripe subscription price for tenant ${tenantId}: ${oldAmount ?? "?"} -> ${newAmount} (${interval}, proration_behavior=none)`,
    );
    return { synced: true, oldAmount, newAmount };
  }

  /**
   * Keep platform MRR in step with a re-priced tenant: `basePriceSnapshot` is the
   * monthly run-rate MrrService prices each paying subscription from, and the
   * append-only BillingEvent ledger reconciles against Σ `amountDelta`. Without this
   * an admin price change moves the money Stripe collects but neither MRR source.
   *
   * NO-OP when the tenant isn't in the paying set (`planKey == null` — MrrService's own
   * predicate) or when the run-rate is unchanged, so the ledger never drifts from the
   * snapshot total.
   */
  private async reconcilePriceLedger(
    tenantId: string,
    resolvedMonthly: number,
    planKey: string,
    sync: { synced: boolean; reason?: string },
  ): Promise<void> {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { planKey: true, basePriceSnapshot: true },
    });
    if (!sub || sub.planKey == null) return;

    const oldMonthly = sub.basePriceSnapshot != null ? Number(sub.basePriceSnapshot) : 0;
    const newMonthly = roundMoney(resolvedMonthly);
    if (oldMonthly === newMonthly) return;

    await this.prisma.tenantSubscription.update({
      where: { tenantId },
      data: { basePriceSnapshot: newMonthly },
    });
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
      { amountDelta: roundMoney(newMonthly - oldMonthly) },
    );
  }

  // ─── Billing Portal ───────────────────────────────────────────────────────

  async createBillingPortalSession(
    tenantId: string,
    returnUrl?: string,
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

    const portalSession = await this.stripe.createBillingPortalSession({
      customerId: sub.stripeCustomerId,
      returnUrl: returnUrl ?? `${baseUrl}/settings/billing`,
    });

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
        break;

      case "invoice.payment_succeeded":
        await this.onPaymentSucceeded(event.data.object);
        break;

      case "invoice.payment_failed":
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

    // Fetch the full subscription to get period dates
    const stripeSub = await this.stripe.getSubscription(subscriptionId);
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
      select: { priceOverrideMonthly: true, priceOverrideAnnual: true },
    });
    const hasNegotiatedOverride =
      existingOverride?.priceOverrideMonthly != null ||
      existingOverride?.priceOverrideAnnual != null;

    const upserted = await this.prisma.tenantSubscription.upsert({
      where: { tenantId },
      create: {
        tenantId,
        stripeCustomerId: session.customer as string,
        stripeSubId: subscriptionId,
        currentPlan: resolvedPlanKey
          ? planKeyToEnum(resolvedPlanKey)
          : ((session.metadata?.plan as TenantPlan) ?? "STARTER"),
        planKey: resolvedPlanKey,
        basePriceSnapshot: resolvedBasePrice,
        periodStart: new Date(stripeSub.current_period_start * 1000),
        periodEnd: new Date(stripeSub.current_period_end * 1000),
        billingInterval,
      },
      update: {
        stripeSubId: subscriptionId,
        stripeCustomerId: session.customer as string,
        periodStart: new Date(stripeSub.current_period_start * 1000),
        periodEnd: new Date(stripeSub.current_period_end * 1000),
        ...(billingInterval ? { billingInterval } : {}),
        ...(resolvedPlanKey ? { planKey: resolvedPlanKey } : {}),
        ...(resolvedPlanKey && resolvedBasePrice != null && !hasNegotiatedOverride
          ? { basePriceSnapshot: resolvedBasePrice }
          : {}),
      },
    });

    // Atomic non-ACTIVE→ACTIVE: activates the tenant, and if it was previously non-paying (e.g.
    // SUSPENDED) re-adds its run-rate exactly once — idempotent against the paired
    // invoice.payment_succeeded webhook. NO-OP for a fresh Stripe checkout (planKey is null —
    // legacy Stripe doesn't set it, so emitPayingDelta short-circuits).
    const reinstated = await this.transitionAndEmit(
      tenantId,
      upserted,
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

    this.logger.log(`Tenant ${tenantId} activated via checkout (sub: ${subscriptionId})`);
  }

  private async onPaymentSucceeded(invoice: any): Promise<void> {
    const customerId =
      typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

    if (!customerId) return;

    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { stripeCustomerId: customerId },
      // R2: the tenant's CURRENT status is what decides whether the cancelAtPeriodEnd guard
      // below applies — onPaymentFailed already includes the tenant the same way.
      include: { tenant: { select: { status: true } } },
    });
    if (!sub) {
      this.logger.debug(
        `No tenant found for Stripe customer ${customerId} (invoice.payment_succeeded)`,
      );
      return;
    }

    // Fetch the subscription to update period dates
    if (sub.stripeSubId) {
      try {
        const stripeSub = await this.stripe.getSubscription(sub.stripeSubId);
        await this.prisma.tenantSubscription.update({
          where: { tenantId: sub.tenantId },
          data: {
            periodStart: new Date(stripeSub.current_period_start * 1000),
            periodEnd: new Date(stripeSub.current_period_end * 1000),
          },
        });
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

    // Atomic non-ACTIVE→ACTIVE: reinstates a dropped-out tenant and re-adds its run-rate exactly
    // once. The conditional flip is the idempotency key — the paired checkout.session.completed
    // webhook races here and only the winner emits — and it is a NO-OP on ordinary renewals
    // (already ACTIVE → count 0 → no ledger delta).
    const reinstated = await this.transitionAndEmit(
      sub.tenantId,
      sub,
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

    this.logger.log(`Payment succeeded for tenant ${sub.tenantId} (customer ${customerId})`);
  }

  private async onPaymentFailed(invoice: any): Promise<void> {
    const customerId =
      typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

    if (!customerId) return;

    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { stripeCustomerId: customerId },
      include: { tenant: { select: { id: true, slug: true, name: true } } },
    });
    if (!sub) return;

    this.logger.warn(
      `Payment failed for tenant ${sub.tenantId} (${sub.tenant.slug}). Grace period: ${PAYMENT_GRACE_DAYS} days.`,
    );

    // Send warning email to tenant admin
    const adminUser = await this.prisma.user.findFirst({
      where: { tenantId: sub.tenantId, role: "TENANT_ADMIN", deletedAt: null },
      select: { email: true, username: true },
    });

    if (adminUser?.email) {
      try {
        await this.email.send({
          to: adminUser.email,
          subject: `Payment failed — ${sub.tenant.name ?? sub.tenant.slug}`,
          html: `<p>Hello ${adminUser.username},</p>
<p>We were unable to process your subscription payment for <strong>${sub.tenant.name ?? sub.tenant.slug}</strong>.</p>
<p>Please update your payment method within <strong>${PAYMENT_GRACE_DAYS} days</strong> to avoid service interruption.</p>
<p>You can update your payment details by contacting support or visiting your billing portal.</p>
<p>RouteFlow Platform</p>`,
        });
      } catch {
        /* best-effort */
      }
    }
  }

  private async onSubscriptionDeleted(subscription: any): Promise<void> {
    const customerId =
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;

    if (!customerId) return;

    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { stripeCustomerId: customerId },
    });
    if (!sub) return;

    // Atomic ACTIVE→CANCELLED: emits the −MRR delta exactly once, even across duplicate webhooks
    // or a race with the plans-as-data cron (both leave a non-ACTIVE status → count 0 here).
    const churned = await this.transitionAndEmit(
      sub.tenantId,
      sub,
      { status: "ACTIVE" },
      "CANCELLED",
      -1,
      BILLING_EVENTS.SUBSCRIPTION_CANCELED,
      { source: "stripe", reason: "subscription_deleted" },
    );
    // Not a paying→churn transition (already non-ACTIVE) — still land the Stripe-deleted tenant in
    // CANCELLED (a terminal hard-block), without a duplicate ledger delta.
    if (!churned) {
      await this.prisma.tenant.update({
        where: { id: sub.tenantId },
        data: { status: "CANCELLED" },
      });
    }
    this.tenantStatusGuard.invalidate(sub.tenantId);

    // A cancellation SUPERSEDES any scheduled downgrade — the same rule the self-service
    // cancel() applies (subscription-mutation.service.ts). Left armed, the 02:00 sweep would
    // re-price basePriceSnapshot on an already-churned tenant and book a second MRR delta.
    await this.prisma.tenantSubscription.update({
      where: { tenantId: sub.tenantId },
      data: { cancelAtPeriodEnd: true, ...disarmedDowngrade() },
    });

    this.logger.log(`Subscription cancelled for tenant ${sub.tenantId} (customer ${customerId})`);
  }

  private async onSubscriptionUpdated(subscription: any): Promise<void> {
    const customerId =
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;

    if (!customerId) return;

    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { stripeCustomerId: customerId },
    });
    if (!sub) return;

    // Update period dates and cancellation flag. The downgrade markers are cleared ONLY when
    // this event ARMS a cancellation (a cancellation supersedes a scheduled downgrade, as
    // cancel() rules): clearing them on every update would let an unrelated Stripe write (a
    // cycle roll, a price sync, an add-on item) silently drop a schedule the tenant made here.
    await this.prisma.tenantSubscription.update({
      where: { tenantId: sub.tenantId },
      data: {
        periodStart: new Date(subscription.current_period_start * 1000),
        periodEnd: new Date(subscription.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        ...(subscription.cancel_at_period_end === true ? disarmedDowngrade() : {}),
      },
    });

    this.logger.debug(
      `Subscription updated for tenant ${sub.tenantId} — cancel_at_period_end: ${subscription.cancel_at_period_end}`,
    );
  }

  // ─── Cron: suspend tenants with expired trials / overdue payments ─────────

  /**
   * Runs every hour. Suspends tenants that:
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
        if (
          stripeSub.status === "past_due" ||
          stripeSub.status === "unpaid" ||
          stripeSub.status === "canceled"
        ) {
          // Atomic ACTIVE→SUSPENDED: emits the −MRR delta exactly once even if a concurrent
          // subscription.deleted webhook already churned this tenant (count 0 → no double). The
          // suspension is reversible — onPaymentSucceeded re-adds a matching +delta on reinstatement.
          const suspended = await this.transitionAndEmit(
            sub.tenantId,
            sub,
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
