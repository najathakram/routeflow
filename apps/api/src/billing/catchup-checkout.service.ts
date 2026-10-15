import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { fromCents, toCents } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { addonCatalogInvalidException } from "./addon-catalog-invalid";
import { ADMIN_AUDIT_ENTITY } from "../platform-admin/audit-actions.constant";
import { PrismaService } from "../prisma/prisma.service";
import { billableAddonWhere } from "./addon-row";
import { BillingService } from "./billing.service";
import { CatchupClaimService } from "./catchup-claim.service";
import {
  planCatchup,
  type CatchupAddon,
  type CatchupAddonRow,
  type CatchupPlan,
  type CatchupPlanResult,
} from "./catchup-plan";
import {
  CATCHUP_MARKER_ACTIONS,
  CATCHUP_MARKER_SELECT,
  readCatchupMarkers,
  type MarkerView,
} from "./catchup-markers";
import { planRefusalException, refusalCodesOf } from "./catchup-refusal";
import { buildCatchupSessionParams } from "./catchup-session-params";
import { PlatformPricingService } from "./platform-pricing.service";
import { withCheckoutPolicy } from "./checkout-session-params";
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
  /** The coded refusals (UPPER_SNAKE) behind `ineligible`: what the owner's list prints per tenant id. */
  refusals?: string[];
  claimState: string | null;
  hasStripeSubscription: boolean;
  externalPayment: boolean;
  planKey: string | null;
  priceSource: "override" | "catalog" | null;
  monthlyCents: number | null;
  /** The subscription row's stored base-price snapshot, dollars (null when none) - the dry-run flags an override without one. */
  basePriceSnapshot: number | null;
  /** The latest billing-start override marker (valid or not), for the dry-run. */
  billingStartOverride: { billingStart: string | null; valid: boolean } | null;
  /** The activation markers and whether each counts as paid coverage, is voided, or was restored. */
  markers: MarkerView[];
  rfInvoices: { open: number; paid: number };
  /** The manual subscription's current period (printed in the dry-run: the owner checks it against the invoices). */
  subPeriod?: { start: Date | null; end: Date | null } | null;
  plan: CatchupPlanResult;
  /** For the session: the pieces `open()` needs (not serialised). */
  _inputs?: { planPriceData: Record<string, any>; addonLines: any[]; addonSkus: string[] };
  /** Add-ons the quiet read dropped for an unparseable catalog includedAtPlan (internal; the open() refuses on it). */
  _catalogInvalid?: { sku: string; value: string }[];
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
    refusals: refusalCodesOf(r.ineligible),
    claimState: r.claimState,
    hasStripeSubscription: r.hasStripeSubscription,
    externalPayment: r.externalPayment,
    planKey: r.planKey,
    priceSource: r.priceSource,
    monthlyCents: r.monthlyCents,
    basePriceSnapshot: r.basePriceSnapshot,
    billingStartOverride: r.billingStartOverride,
    markers: r.markers,
    rfInvoices: r.rfInvoices,
    subPeriod: r.subPeriod
      ? {
          start: r.subPeriod.start ? iso(r.subPeriod.start) : null,
          end: r.subPeriod.end ? iso(r.subPeriod.end) : null,
        }
      : null,
    plan: p.ok
      ? {
          ok: true as const,
          shape: p.shape,
          floor: iso(p.floor),
          floorSource: p.floorSource,
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
      select: {
        stripeSubId: true,
        externalPayment: true,
        catchupState: true,
        planKey: true,
        periodStart: true,
        periodEnd: true,
        basePriceSnapshot: true,
      },
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
    // B1102: a held add-on whose catalog includedAtPlan names no plan is CATALOG_INVALID, not "not card billable".
    if (lines.invalid.length > 0) ineligible.push("addon_catalog_invalid");
    const addons: CatchupAddon[] = lines.lineItems.map((li: any) => ({
      sku: String(li.price_data?.product_data?.metadata?.addonSku ?? "ADDON"),
      unitPrice: fromCents(Number(li.price_data?.unit_amount ?? 0)),
      quantity: Number(li.quantity ?? 0),
    }));

    // MF1: the priced billable ROWS the manual invoice bills today, against the lines the card will bill.
    const addonRows = (await this.prisma.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId, active: true }),
      select: { sku: true, addonKey: true, quantity: true, priceSnapshot: true },
    })) as {
      sku: string | null;
      addonKey: string | null;
      quantity: number;
      priceSnapshot: unknown;
    }[];
    const billableRows: CatchupAddonRow[] = addonRows.map((r) => ({
      code: String(r.sku ?? r.addonKey ?? "ADDON"),
      quantity: Number(r.quantity),
      unitPrice: r.priceSnapshot == null ? null : Number(r.priceSnapshot),
    }));

    const rows = (await this.prisma.rfInvoice.findMany({
      where: { tenantId, status: { in: ["OPEN", "PAID"] } },
      select: { id: true, status: true, periodStart: true, periodEnd: true },
    })) as { id: string; status: string; periodStart: Date | null; periodEnd: Date | null }[];

    // ONE query for every marker kind (SA-733r11/r12): the activation marker + trail rows, the coverage VOID /
    // RESTORE corrections and the billing-start override. The plan measures paid coverage from the activations
    // (unsnapped, a voided one ignored) and fails closed on one with no recorded period.
    const markerRows = (await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        entityType: ADMIN_AUDIT_ENTITY,
        action: { in: [...CATCHUP_MARKER_ACTIONS] },
      },
      orderBy: { createdAt: "asc" },
      select: CATCHUP_MARKER_SELECT,
    })) as { id: string; action: string; createdAt: Date; meta: Record<string, unknown> | null }[];
    const markers = readCatchupMarkers(markerRows);
    const override = markers.billingStartOverride;
    if (override && !override.ok) ineligible.push("invalid_billing_start");
    const plan = planCatchup({
      now,
      monthly,
      addons,
      invoices: rows,
      billableRows,
      // an override REPLACES the first-activation term of the floor; with none the planner reads the first activation
      billingStart: override?.ok ? override.billingStart : null,
      manual: { activations: markers.activations },
    });
    if (!plan.ok) ineligible.push(plan.reason);
    if (plan.ok) {
      // an OPEN RfInvoice whose period cannot be placed would be left standing beside the card subscription
      if (plan.unplaceableOpenIds.length > 0) ineligible.push("unplaceable_open_invoice");
    }
    // Defensive: resolveTenantPricing falls back to STARTER, so this never fires today; it keeps a null key from
    // ever reaching the session (completion would otherwise transition the tenant to the wrong plan).
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
      basePriceSnapshot: sub?.basePriceSnapshot == null ? null : Number(sub.basePriceSnapshot),
      billingStartOverride: override
        ? {
            billingStart: override.ok ? override.billingStart.toISOString() : String(override.raw),
            valid: override.ok,
          }
        : null,
      markers: markers.markers,
      rfInvoices: {
        open: rows.filter((r) => r.status === "OPEN").length,
        paid: rows.filter((r) => r.status === "PAID").length,
      },
      subPeriod: sub ? { start: sub.periodStart ?? null, end: sub.periodEnd ?? null } : null,
      plan,
      _inputs: { planPriceData, addonLines: lines.lineItems, addonSkus: lines.skus },
      _catalogInvalid: lines.invalid,
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
        anchorNoLine: 0, // unreachable since SA-733r9 (kept so the dry-run census keeps its columns)
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
    opts: { expectedStubCents: number; now?: Date; successUrl?: string; cancelUrl?: string },
  ): Promise<{ checkoutUrl: string; sessionId: string; stubCents: number; shape: string }> {
    const now = opts.now ?? new Date();
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException("Stripe is not configured.");
    }
    const report = await this.plan(tenantId, now);
    if (report._catalogInvalid?.length) {
      // B1102: the coded 409 + the platform notice, BEFORE the plan's own (misleading) card-billable refusal.
      await this.mutations.recordInvalidCatalogAddons(tenantId, report._catalogInvalid);
      const first = report._catalogInvalid[0];
      throw addonCatalogInvalidException(first.sku, first.value);
    }
    if (!report.plan.ok) {
      // a coded refusal with fixed copy: never the internal reason string
      throw planRefusalException(report.plan.reason);
    }
    const plan: CatchupPlan = report.plan;
    const blockers = report.ineligible;
    if (blockers.includes("has_stripe_subscription")) {
      // r2 / r5: an existing stripeSubId is a census item the owner rules on, never silently converted
      throw planRefusalException("has_stripe_subscription");
    }
    if (blockers.length) {
      throw new ConflictException({
        code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE,
        message: "This tenant is not eligible for a catch-up checkout. Nothing was created.",
        // structured, for the operator's tool - never shown as copy
        reasons: blockers,
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
        successUrl: opts.successUrl ?? `${base}/settings/billing?checkout=success`,
        cancelUrl: opts.cancelUrl ?? `${base}/settings/billing?checkout=cancelled`,
      });
      session = await this.stripe.client.checkout.sessions.create(withCheckoutPolicy(params), {
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
