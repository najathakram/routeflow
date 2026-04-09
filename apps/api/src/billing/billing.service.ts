import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { TenantPlan } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { StripeService } from "./stripe.service";

/** Grace period (in days) after a payment failure before suspending the tenant. */
const PAYMENT_GRACE_DAYS = 3;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly email: EmailService,
    private readonly tenantStatusGuard: TenantStatusGuard,
  ) {}

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
   * Creates a Stripe Checkout Session for a tenant to subscribe.
   * Returns the checkout URL that the tenant owner should visit to pay.
   */
  async createCheckoutSession(
    tenantId: string,
    opts?: { successUrl?: string; cancelUrl?: string },
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, plan: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    if (!this.stripe.isConfigured) {
      throw new BadRequestException(
        "Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.",
      );
    }

    const customerId = await this.ensureStripeCustomer(tenantId);
    const priceId = this.stripe.getPriceIdForPlan(tenant.plan ?? "STARTER");

    if (!priceId) {
      throw new BadRequestException(
        `No Stripe price configured for plan ${tenant.plan}. Set STRIPE_PRICE_${tenant.plan} env var.`,
      );
    }

    const baseUrl = process.env.FRONTEND_URL ?? "http://localhost:3001";

    const session = await this.stripe.createCheckoutSession({
      customerId,
      priceId,
      successUrl: opts?.successUrl ?? `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: opts?.cancelUrl ?? `${baseUrl}/billing/cancel`,
      metadata: { tenantId, slug: tenant.slug },
    });

    this.logger.log(`Checkout session ${session.id} created for tenant ${tenantId}`);
    return { checkoutUrl: session.url, sessionId: session.id };
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

    await this.prisma.tenantSubscription.upsert({
      where: { tenantId },
      create: {
        tenantId,
        stripeCustomerId: session.customer as string,
        stripeSubId: subscriptionId,
        currentPlan: (session.metadata?.plan as TenantPlan) ?? "STARTER",
        periodStart: new Date(stripeSub.current_period_start * 1000),
        periodEnd: new Date(stripeSub.current_period_end * 1000),
      },
      update: {
        stripeSubId: subscriptionId,
        stripeCustomerId: session.customer as string,
        periodStart: new Date(stripeSub.current_period_start * 1000),
        periodEnd: new Date(stripeSub.current_period_end * 1000),
      },
    });

    // Activate the tenant
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { status: "ACTIVE" },
    });
    this.tenantStatusGuard.invalidate(tenantId);

    this.logger.log(`Tenant ${tenantId} activated via checkout (sub: ${subscriptionId})`);
  }

  private async onPaymentSucceeded(invoice: any): Promise<void> {
    const customerId =
      typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

    if (!customerId) return;

    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { stripeCustomerId: customerId },
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

    // Ensure tenant is ACTIVE (in case it was previously past-due)
    await this.prisma.tenant.update({
      where: { id: sub.tenantId },
      data: { status: "ACTIVE" },
    });
    this.tenantStatusGuard.invalidate(sub.tenantId);

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

    await this.prisma.tenant.update({
      where: { id: sub.tenantId },
      data: { status: "CANCELLED" },
    });
    this.tenantStatusGuard.invalidate(sub.tenantId);

    await this.prisma.tenantSubscription.update({
      where: { tenantId: sub.tenantId },
      data: { cancelAtPeriodEnd: true },
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

    // Update period dates and cancellation flag
    await this.prisma.tenantSubscription.update({
      where: { tenantId: sub.tenantId },
      data: {
        periodStart: new Date(subscription.current_period_start * 1000),
        periodEnd: new Date(subscription.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
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
  @Cron(CronExpression.EVERY_HOUR)
  async suspendOverdueTenants(): Promise<void> {
    if (!this.stripe.isConfigured) return; // No billing = no suspension logic

    const now = new Date();
    const graceDeadline = new Date(now.getTime() - PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000);

    // 1. Expired trials
    const expiredTrials = await this.prisma.tenant.findMany({
      where: {
        status: "TRIAL",
        trialEndsAt: { lt: now },
        deletedAt: null,
      },
      select: { id: true, slug: true },
    });

    for (const tenant of expiredTrials) {
      await this.prisma.tenant.update({
        where: { id: tenant.id },
        data: { status: "SUSPENDED" },
      });
      this.tenantStatusGuard.invalidate(tenant.id);
      this.logger.log(`Trial expired — suspended tenant ${tenant.slug}`);
    }

    // 2. Overdue subscriptions (periodEnd + grace past, still ACTIVE, no recent payment)
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
          await this.prisma.tenant.update({
            where: { id: sub.tenantId },
            data: { status: "SUSPENDED" },
          });
          this.tenantStatusGuard.invalidate(sub.tenantId);
          this.logger.log(
            `Overdue payment — suspended tenant ${sub.tenant.slug} (Stripe status: ${stripeSub.status})`,
          );
        }
      } catch (err) {
        this.logger.error(`Failed to check Stripe subscription for tenant ${sub.tenantId}`, err);
      }
    }

    if (expiredTrials.length > 0 || overdueSubs.length > 0) {
      this.logger.log(
        `Suspension cron: ${expiredTrials.length} expired trials, ${overdueSubs.length} overdue checked`,
      );
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
