import { Injectable } from "@nestjs/common";
import { MeterKey } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { EntitlementsService } from "./entitlements.service";
import { MeterService } from "./meter.service";
import {
  addonSkuCode,
  isInviteOnlyPlanKey,
  INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT,
} from "./plan-catalog.constants";
import { computeServedFlags } from "./plan-flag-policy";
import { FeatureOverrideService } from "./feature-override.service";
import {
  EMPTY_BILLING_VIEW_EXTRAS,
  SubscriptionBillingExtras,
} from "./subscription-billing-extras";
import {
  BILLING_EXPORT_INVOICE_FIELDS,
  EXPORT_EXCLUDED_EVENT_TYPES,
  deriveExportActor,
  projectBillingEventForExport,
  projectInvoiceForExport,
  projectSubscriptionForExport,
  projectUsageForExport,
} from "./billing-export-fields";

/**
 * Tenant self-service READ surface for settings-billing + choose-plan: the current
 * subscription view, live meter usage, and a usage-fit plan recommendation. Read-only
 * — the subscribe/upgrade/downgrade mutations land in Phase 4.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: PlanCatalogService,
    private readonly entitlements: EntitlementsService,
    private readonly meters: MeterService,
    // Optional (not a real DI concern — BillingModule already provides it, so production
    // always wires a real instance): keeps this file's large existing test surface passing
    // unchanged rather than adding a 5th arg to every one of its `new SubscriptionService(...)`
    // call sites. Absent (undefined) degrades to "no override", byte-identical to today.
    private readonly featureOverrides?: FeatureOverrideService,
    // SA-733r6 (B4): billing-contact name, open-invoice amount and the autopay card (Stripe-backed, cached).
    // Optional for the same reason as above; absent = the four fields read null.
    private readonly billingExtras?: SubscriptionBillingExtras,
  ) {}

  /** The tenant's current plan + add-ons + renewal state (settings-billing header). */
  async getSubscription(tenantId: string) {
    const ent = await this.entitlements.resolve(tenantId);
    const version = await this.catalog.getVersionForTenant(ent.planVersionId);
    const def = version.definitions.find((d) => d.planKey === ent.planKey);
    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    const addonRows = await this.prisma.tenantAddon.findMany({ where: { tenantId, active: true } });
    const skuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));

    const addons = addonRows.map((r) => {
      const code = addonSkuCode(r);
      const sku = code ? skuByCode.get(code) : undefined;
      return {
        sku: code,
        name: sku?.name ?? code ?? r.addonKey,
        quantity: r.quantity,
        monthly: sku ? Number(sku.monthlyPrice) * r.quantity : null,
      };
    });

    const monthlyPrice =
      sub?.priceOverrideMonthly != null
        ? Number(sub.priceOverrideMonthly)
        : def?.monthlyPrice != null
          ? Number(def.monthlyPrice)
          : null;

    // Defensive `?? []`: EntitlementsService.resolve() always sets `flags`, but some
    // unit-test callers (SubscriptionService.spec) construct a bare entitlements mock
    // without it — never let a missing array crash the settings-billing view.
    const entFlags = ent.flags ?? [];

    // Feature-grants PR-1 (owner ruling 2026-09-16): an active override is absolute, and this
    // IS the web's actual flag-gating read path (usePlanFlag → useSubscription().flags → nav/
    // lock-wall gates) — without this merge, a GRANT override is invisible (nav stays hidden)
    // and a DENY override dead-ends (nav shown, every call 403s). Mirrors tenants.controller.ts's
    // getMyAddons merge, filtered to RequirePlanFlag-gated keys only (an addon-keyed override
    // has no business in this array — see gateVia/item 6's parity fix).
    const overrides = this.featureOverrides
      ? await this.featureOverrides.allActive(tenantId)
      : new Map();

    // SA-733r6 (B4): who to ask, what is owed, which card autopay will charge. A failed read is null, never a throw.
    const extras = this.billingExtras
      ? await this.billingExtras.read(tenantId, sub)
      : EMPTY_BILLING_VIEW_EXTRAS;

    return {
      planKey: ent.planKey,
      // R1.7/R2.5: the flags this tenant can actually use right now — the union of its own
      // stored entitlement flags and any FLAG_KEYS still under the dark-flag courtesy allow
      // (see allowsFlag/isDarkFlag), with any RequirePlanFlag-keyed override folded in last.
      // computeServedFlags is shared with EntitlementAuthority.servedFlags() (feature grants
      // v2, Opus review of 9923b87c item 2) so the two are provably identical, not just
      // tested-equal — see entitlement-authority.service.spec.ts's served-parity oracle.
      flags: computeServedFlags(ent.planKey, entFlags, overrides),
      // R2.8/R2.9/R7.6: an invited-but-not-yet-paying LITE tenant needs to complete
      // Stripe checkout before it's truly ACTIVE — structural, never derived from a
      // client-supplied planKey (see SettingsBillingController.createCheckout).
      paymentRequired:
        isInviteOnlyPlanKey(ent.planKey) &&
        ent.status !== "ACTIVE" &&
        INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT,
      planName: ent.planName,
      status: ent.status,
      // RO-1: why the tenant is READ_ONLY (trial_expired | subscription_cancelled |
      // trial_cancelled) — see EntitlementsService.resolve().
      readOnlyReason: ent.readOnlyReason ?? null,
      cycle: sub?.cycle ?? "MONTHLY",
      // A per-tenant custom fee is what Stripe actually bills — show THAT, never the
      // catalog number it replaced, or the tenant sees one price and is charged another.
      // Mirrors PlatformPricingService.resolveTenantPricing (annual → monthly × 10).
      monthlyPrice,
      annualPrice:
        sub?.priceOverrideAnnual != null
          ? Number(sub.priceOverrideAnnual)
          : sub?.priceOverrideMonthly != null
            ? Number(sub.priceOverrideMonthly) * 10
            : def?.annualPrice != null
              ? Number(def.annualPrice)
              : null,
      isCustom: def?.isCustom ?? false,
      renewalAt: sub?.periodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      downgradeToPlanKey: sub?.downgradeToPlanKey ?? null,
      downgradeEffectiveAt: sub?.downgradeEffectiveAt ?? null,
      trialEndsAt: ent.trialEndsAt,
      addons,
      // SA-733r6 (B4): dunning facts + the banner extras. The server decides read-only; the client only renders.
      pastDueSince: sub?.pastDueSince ?? null,
      pastDueInvoiceId: sub?.pastDueInvoiceId ?? null,
      billingContactName: extras.billingContactName,
      openInvoiceAmount: extras.openInvoiceAmount,
      paymentMethodSummary: extras.paymentMethodSummary,
      nextCharge: extras.nextCharge,
    };
  }

  /** The hosted-invoice page of the invoice the tenant owes (the admin's Pay link); null when nothing is owed. */
  async openInvoiceUrl(tenantId: string): Promise<string | null> {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { pastDueInvoiceId: true },
    });
    if (!sub?.pastDueInvoiceId || !this.billingExtras) return null;
    return this.billingExtras.hostedInvoiceUrl(sub.pastDueInvoiceId);
  }

  /** The four meters for the settings-billing usage bars. */
  async getUsage(tenantId: string) {
    return this.meters.readAll(tenantId);
  }

  /** Billing-domain data export (subscription + usage + audit + invoices). A GET, so it
   *  keeps working while the tenant is READ_ONLY (trial expiry keeps exports available). */
  async getExport(tenantId: string) {
    const [subscription, usage, billingEvents, invoices] = await Promise.all([
      this.getSubscription(tenantId),
      this.getUsage(tenantId),
      this.prisma.billingEvent.findMany({
        where: { tenantId, type: { notIn: [...EXPORT_EXCLUDED_EVENT_TYPES] } },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      // B1187 / SA-718: select exactly the allowlist (ONE list, billing-export-fields.ts); never the whole row.
      this.prisma.rfInvoice.findMany({
        where: { tenantId },
        select: Object.fromEntries(BILLING_EXPORT_INVOICE_FIELDS.map((f) => [f, true])) as Record<
          (typeof BILLING_EXPORT_INVOICE_FIELDS)[number],
          true
        >,
        orderBy: { issuedAt: "desc" },
        take: 500,
      }),
    ]);
    // B1187 / SA-718: both arrays are PROJECTED through the allowlists in billing-export-fields.ts;
    // `actorId` becomes a derived label and is never exported.
    const actorIds = [
      ...new Set(billingEvents.map((e) => e.actorId).filter((id): id is string => !!id)),
    ];
    // Explicitly tenant-scoped: another tenant's (or platform staff's) user row is never read, so
    // any actor not found here is labelled "RouteFlow support" by deriveExportActor.
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { tenantId, id: { in: actorIds } },
          select: { id: true, role: true, tenantId: true },
        })
      : [];
    const actorById = new Map(actors.map((u) => [u.id, u]));
    return {
      exportedAt: new Date().toISOString(),
      subscription: projectSubscriptionForExport(subscription),
      usage: projectUsageForExport(usage),
      billingEvents: billingEvents.map((e) =>
        projectBillingEventForExport(
          e,
          deriveExportActor(e.actorId, e.actorId ? actorById.get(e.actorId) : undefined, tenantId),
        ),
      ),
      invoices: invoices.map((i) => projectInvoiceForExport(i)),
    };
  }

  /**
   * Usage-fit recommendation for choose-plan: for each plan, whether current usage
   * fits its caps + the over-cap deltas, and the cheapest fitting plan. Cap-based
   * (seats/routes/scans/msgs are metered; feature-flag usage is not), so it's a
   * lower bound — the UI still shows per-card consequences before the user picks.
   */
  async getRecommendation(tenantId: string) {
    const [usageReadings, version, ent] = await Promise.all([
      this.meters.readAll(tenantId),
      this.catalog.getPublishedCatalog(),
      this.entitlements.resolve(tenantId),
    ]);
    const used = usageReadings.reduce(
      (acc, u) => ((acc[u.meter] = u.used), acc),
      {} as Record<MeterKey, number>,
    );

    const overBy = (u: number, cap: number | null): number =>
      cap == null ? 0 : Math.max(0, u - cap);
    const fits = (u: number, cap: number | null): boolean => cap == null || u <= cap;

    const perPlan = [...version.definitions]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((def) => ({
        planKey: def.planKey,
        name: def.name,
        monthly: def.monthlyPrice != null ? Number(def.monthlyPrice) : null,
        isCustom: def.isCustom,
        fits:
          fits(used.SEATS ?? 0, def.seatsIncluded) &&
          fits(used.ROUTES ?? 0, def.routesConcurrent) &&
          fits(used.SCANS ?? 0, def.scansIncluded) &&
          fits(used.MSGS ?? 0, def.msgsIncluded),
        over: {
          seats: overBy(used.SEATS ?? 0, def.seatsIncluded),
          routes: overBy(used.ROUTES ?? 0, def.routesConcurrent),
          scans: overBy(used.SCANS ?? 0, def.scansIncluded),
          msgs: overBy(used.MSGS ?? 0, def.msgsIncluded),
        },
      }));

    const cheapestFitting = perPlan
      .filter((p) => p.fits && p.monthly != null)
      .sort((a, b) => (a.monthly as number) - (b.monthly as number))[0];

    return {
      currentPlanKey: ent.planKey,
      usage: {
        seats: used.SEATS ?? 0,
        routes: used.ROUTES ?? 0,
        scans: used.SCANS ?? 0,
        msgs: used.MSGS ?? 0,
      },
      perPlan,
      recommendedPlanKey: cheapestFitting?.planKey ?? "ENTERPRISE",
      preCheckedAddons: ent.addons,
    };
  }
}
