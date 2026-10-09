import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { fromCents, toCents } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { PrismaService } from "../prisma/prisma.service";
import { BillingService } from "./billing.service";
import { CatchupClaimService } from "./catchup-claim.service";
import {
  CATCHUP_GO_LIVE,
  planCatchup,
  type CatchupAddon,
  type CatchupPlan,
  type CatchupPlanResult,
} from "./catchup-plan";
import { buildCatchupSessionParams } from "./catchup-session-params";
import { PlatformPricingService } from "./platform-pricing.service";
import { StripeService } from "./stripe.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";

/**
 * SA-733 D7: plan and open an existing (manually invoiced) tenant's October catch-up. `plan()` is READ-ONLY (the
 * dry-run the owner checks); `open()` claims, creates ONE Checkout session and stores its id. The amounts come
 * from one place: the tenant's resolved price (override beats catalog - PlatformPricingService), its billable
 * add-on lines (the very lines the recurring subscription will bill), and its RfInvoices.
 */

export interface CatchupReport {
  tenantId: string;
  slug: string;
  /** For the tool's protected-tenant guard (class / status decide "paying"). */
  tenantClass: string;
  tenantStatus: string;
  eligible: boolean;
  ineligible: string[];
  claimState: string | null;
  hasStripeSubscription: boolean;
  externalPayment: boolean;
  planKey: string | null;
  priceSource: "override" | "catalog" | null;
  monthlyCents: number | null;
  rfInvoices: { open: number; paid: number };
  plan: CatchupPlanResult;
  /** For the session: the pieces `open()` needs (not serialised). */
  _inputs?: { planPriceData: Record<string, any>; addonLines: any[]; addonSkus: string[] };
}

/** The plan changed between the dry-run read and the claim (re-planned under the claim). */
class ChangedUnderClaim extends Error {}

export interface CatchupCensus {
  counts: Record<string, number>;
  tenants: ReturnType<typeof catchupReportJson>[];
  failed: string[];
}

const iso = (d: Date) => d.toISOString();

/** A JSON-safe view of a report (no Date objects, no private inputs, no names). */
export function catchupReportJson(r: CatchupReport) {
  const p = r.plan;
  return {
    tenantId: r.tenantId,
    tenantClass: r.tenantClass,
    tenantStatus: r.tenantStatus,
    eligible: r.eligible,
    ineligible: r.ineligible,
    claimState: r.claimState,
    hasStripeSubscription: r.hasStripeSubscription,
    externalPayment: r.externalPayment,
    planKey: r.planKey,
    priceSource: r.priceSource,
    monthlyCents: r.monthlyCents,
    rfInvoices: r.rfInvoices,
    plan: p.ok
      ? {
          ok: true as const,
          shape: p.shape,
          paidThrough: iso(p.paidThrough),
          paidFromInvoices: p.paidFromInvoices,
          anchorAt: iso(p.anchorAt),
          trialEndAt: iso(p.trialEndAt),
          stub: {
            from: iso(p.stub.from),
            to: iso(p.stub.to),
            label: p.stub.label,
            lines: p.stub.lines,
            totalCents: p.stub.totalCents,
            belowStripeMinimum: p.stub.belowStripeMinimum,
          },
          voidInvoiceIds: p.voidInvoiceIds,
          unplaceableOpenIds: p.unplaceableOpenIds,
          notes: p.notes,
        }
      : { ok: false as const, reason: p.reason },
  };
}

@Injectable()
export class CatchupCheckoutService {
  private readonly logger = new Logger(CatchupCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly pricing: PlatformPricingService,
    private readonly mutations: SubscriptionMutationService,
    private readonly claim: CatchupClaimService,
    private readonly billing: BillingService,
  ) {}

  /** READ-ONLY: what a catch-up would do for this tenant right now. Writes nothing, calls no Stripe. */
  async plan(
    tenantId: string,
    now: Date = new Date(),
    opts: { ownClaim?: boolean } = {},
  ): Promise<CatchupReport> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, status: true, class: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) throw new NotFoundException(`Tenant ${tenantId} not found`);
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { stripeSubId: true, externalPayment: true, catchupState: true, planKey: true },
    });

    const ineligible: string[] = [];
    if (!sub) ineligible.push("no_subscription_row");
    if (tenant.status !== "ACTIVE") ineligible.push("tenant_not_active");
    if (sub?.stripeSubId) ineligible.push("has_stripe_subscription");
    if (sub && !sub.externalPayment) ineligible.push("not_manual_invoicing");
    // `ownClaim`: open() re-plans AFTER taking its own claim; that claim is not a reason to refuse itself
    if (sub?.catchupState && !opts.ownClaim) ineligible.push("claim_held");

    let monthly: number | null = null;
    let resolvedPlanKey: string | null = null;
    let source: "override" | "catalog" | null = null;
    let planPriceData: Record<string, any> = {};
    try {
      const resolved = await this.pricing.resolveTenantPricing(tenantId);
      monthly = resolved.monthly;
      resolvedPlanKey = resolved.planKey ?? null;
      source = resolved.source;
      planPriceData = await this.pricing.checkoutPriceData(tenantId, "month");
    } catch (err) {
      ineligible.push("no_resolvable_price");
      this.logger.warn(`catch-up plan tenant ${tenantId}: no price (${(err as Error).message})`);
    }

    const lines = await this.mutations.checkoutAddonLines(tenantId, "month", { quiet: true });
    const addons: CatchupAddon[] = lines.lineItems.map((li: any) => ({
      sku: String(li.price_data?.product_data?.metadata?.addonSku ?? "ADDON"),
      unitPrice: fromCents(Number(li.price_data?.unit_amount ?? 0)),
      quantity: Number(li.quantity ?? 0),
    }));

    const rows = (await this.prisma.rfInvoice.findMany({
      where: { tenantId, status: { in: ["OPEN", "PAID"] } },
      select: { id: true, status: true, periodStart: true, periodEnd: true },
    })) as { id: string; status: string; periodStart: Date | null; periodEnd: Date | null }[];

    // The tenant's billing start (its first manual activation): a tenant activated AFTER go-live is not charged
    // from Oct 1, and is not plainly eligible - the owner confirms the start (Opus item 9).
    const activation = await this.prisma.auditLog.findFirst({
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
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const billingStart = activation?.createdAt ?? null;
    const plan = planCatchup({ now, monthly, addons, invoices: rows, billingStart });
    if (!plan.ok) ineligible.push(plan.reason);
    else {
      if (billingStart && billingStart.getTime() > CATCHUP_GO_LIVE.getTime()) {
        ineligible.push("activated_after_go_live");
      }
      // an OPEN RfInvoice whose period cannot be placed would be left standing beside the card subscription
      if (plan.unplaceableOpenIds.length > 0) ineligible.push("unplaceable_open_invoice");
    }
    if (!resolvedPlanKey && monthly != null) ineligible.push("no_plan_key");

    return {
      tenantId,
      slug: tenant.slug,
      tenantClass: String(tenant.class),
      tenantStatus: String(tenant.status),
      eligible: ineligible.length === 0,
      ineligible,
      claimState: sub?.catchupState ?? null,
      hasStripeSubscription: !!sub?.stripeSubId,
      externalPayment: !!sub?.externalPayment,
      // the RESOLVED plan key (what the ordinary checkout puts in its metadata), never the raw row value
      planKey: resolvedPlanKey,
      priceSource: source,
      monthlyCents: monthly == null ? null : toCents(monthly),
      rfInvoices: {
        open: rows.filter((r) => r.status === "OPEN").length,
        paid: rows.filter((r) => r.status === "PAID").length,
      },
      plan,
      _inputs: { planPriceData, addonLines: lines.lineItems, addonSkus: lines.skus },
    };
  }

  /**
   * READ-ONLY census of every ACTIVE production tenant with a subscription row: who the catch-up would apply to,
   * who is refused and why (a Stripe subscription already stored, no manual invoicing, a held claim, ...). IDs and
   * counts only - the owner's tool prints no name or slug.
   */
  async census(now: Date = new Date()): Promise<CatchupCensus> {
    const rows = (await this.prisma.tenantSubscription.findMany({
      where: { tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" } },
      select: { tenantId: true },
      orderBy: { tenantId: "asc" },
    })) as { tenantId: string }[];
    const tenants: ReturnType<typeof catchupReportJson>[] = [];
    const failed: string[] = [];
    for (const { tenantId } of rows) {
      try {
        tenants.push(catchupReportJson(await this.plan(tenantId, now)));
      } catch (err) {
        failed.push(tenantId);
        this.logger.warn(
          `catch-up census: tenant ${tenantId} could not be planned: ${(err as Error).message}`,
        );
      }
    }
    const count = (f: (t: (typeof tenants)[number]) => boolean) => tenants.filter(f).length;
    return {
      counts: {
        total: rows.length,
        planned: tenants.length,
        failed: failed.length,
        eligible: count((t) => t.eligible),
        withStripeSubscription: count((t) => t.hasStripeSubscription),
        neitherManualNorStripe: count((t) => !t.hasStripeSubscription && !t.externalPayment),
        claimHeld: count((t) => t.claimState != null),
        needsRuling: count((t) => !t.plan.ok || t.hasStripeSubscription),
        trialOneTime: count((t) => t.plan.ok && t.plan.shape === "trial_one_time"),
        trial: count((t) => t.plan.ok && t.plan.shape === "trial"),
        anchorNoLine: count((t) => t.plan.ok && t.plan.shape === "anchor_no_line"),
      },
      tenants,
      failed,
    };
  }

  /**
   * Claim -> ONE Checkout session -> store its id. `expectedStubCents` (what the dry-run showed the owner) must
   * equal the fresh plan, or nothing is created (409 CATCHUP_AMOUNT_CHANGED). A shape Stripe's Checkout rejects
   * is 409 CATCHUP_NEEDS_RULING - never worked around.
   */
  async open(
    tenantId: string,
    opts: { expectedStubCents: number; now?: Date },
  ): Promise<{ checkoutUrl: string; sessionId: string; stubCents: number; shape: string }> {
    const now = opts.now ?? new Date();
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException("Stripe is not configured.");
    }
    const report = await this.plan(tenantId, now);
    if (!report.plan.ok) {
      throw new ConflictException({
        code: API_ERROR_CODES.CATCHUP_NEEDS_RULING,
        message: `This tenant's catch-up cannot be planned (${report.plan.reason}): needs a ruling.`,
      });
    }
    const plan: CatchupPlan = report.plan;
    const blockers = report.ineligible;
    if (blockers.includes("has_stripe_subscription")) {
      // r2 / r5: an existing stripeSubId is a census item the owner rules on, never silently converted
      throw new ConflictException({
        code: API_ERROR_CODES.CATCHUP_NEEDS_RULING,
        message:
          "NEEDS RULING: this tenant already has a Stripe subscription. Nothing was created.",
      });
    }
    if (blockers.length) {
      throw new ConflictException({
        code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE,
        message: `This tenant is not eligible for a catch-up checkout (${blockers.join(", ")}).`,
      });
    }
    const changed = () =>
      new ConflictException({
        code: API_ERROR_CODES.CATCHUP_AMOUNT_CHANGED,
        message:
          "The catch-up amount changed since the dry-run. Run it again and confirm the new amount.",
      });
    if (opts.expectedStubCents !== plan.stub.totalCents) throw changed();

    await this.claim.openClaim(tenantId); // under the Tenant lock, BEFORE any Stripe call
    let session: { id: string; url: string };
    try {
      // Opus SHOULD-FIX 3: the plan above was read BEFORE the claim. Staff may have recorded a cheque in between
      // (the claim now blocks that, but not what already happened): re-plan under the claim and compare. A change
      // drops the claim and creates nothing.
      const fresh = await this.plan(tenantId, now, { ownClaim: true });
      if (
        !fresh.plan.ok ||
        fresh.plan.shape !== plan.shape ||
        fresh.plan.stub.totalCents !== plan.stub.totalCents ||
        fresh.plan.trialEndAt.getTime() !== plan.trialEndAt.getTime() ||
        fresh.ineligible.length > 0
      ) {
        throw new ChangedUnderClaim();
      }
      const customerId = await this.billing.ensureStripeCustomer(tenantId);
      const base = process.env.FRONTEND_URL ?? "http://localhost:3001";
      const params = buildCatchupSessionParams({
        tenantId,
        slug: report.slug,
        planKey: fresh.planKey as string,
        customerId,
        planPriceData: fresh._inputs!.planPriceData,
        addonLines: fresh._inputs!.addonLines,
        addonSkus: fresh._inputs!.addonSkus,
        plan: fresh.plan,
        now,
        successUrl: `${base}/settings/billing?checkout=success`,
        cancelUrl: `${base}/settings/billing?checkout=cancelled`,
      });
      session = await this.stripe.client.checkout.sessions.create(params, {
        idempotencyKey: `${tenantId}:catchup-session:${plan.paidThrough.getTime()}:${now.getTime()}`,
      });
    } catch (err) {
      await this.claim
        .abortClaim(tenantId)
        .catch((e: unknown) =>
          this.logger.error(
            `catch-up: could not drop the claim of ${tenantId} after a failed create: ${(e as Error).message}`,
          ),
        );
      if (err instanceof ChangedUnderClaim) throw changed();
      this.logger.error(`catch-up session for ${tenantId} failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        "We couldn't create the catch-up checkout. Nothing was charged. Please try again.",
      );
    }
    await this.claim.attachSession(tenantId, session.id);
    this.logger.log(
      `Catch-up checkout ${session.id} created for tenant ${tenantId} (shape ${plan.shape}, stub ${plan.stub.totalCents} cents)`,
    );
    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      stubCents: plan.stub.totalCents,
      shape: plan.shape,
    };
  }
}
