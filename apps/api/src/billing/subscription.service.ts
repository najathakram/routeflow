import { Injectable } from "@nestjs/common";
import { MeterKey } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { EntitlementsService } from "./entitlements.service";
import { MeterService } from "./meter.service";
import { addonSkuCode } from "./plan-catalog.constants";

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

    return {
      planKey: ent.planKey,
      planName: ent.planName,
      status: ent.status,
      cycle: sub?.cycle ?? "MONTHLY",
      monthlyPrice: def?.monthlyPrice != null ? Number(def.monthlyPrice) : null,
      annualPrice: def?.annualPrice != null ? Number(def.annualPrice) : null,
      isCustom: def?.isCustom ?? false,
      renewalAt: sub?.periodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      downgradeToPlanKey: sub?.downgradeToPlanKey ?? null,
      downgradeEffectiveAt: sub?.downgradeEffectiveAt ?? null,
      trialEndsAt: ent.trialEndsAt,
      addons,
    };
  }

  /** The four meters for the settings-billing usage bars. */
  async getUsage(tenantId: string) {
    return this.meters.readAll(tenantId);
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
