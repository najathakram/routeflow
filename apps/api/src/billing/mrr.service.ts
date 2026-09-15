import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "@routeflow/pricing";

export interface MrrPlanRow {
  planKey: string;
  tenants: number;
  baseMrr: number;
}

export interface MrrOverview {
  /** Monthly run-rate = Σ(base + add-ons − discounts) over paying (ACTIVE, subscribed) tenants. */
  mrr: number;
  baseMrr: number;
  addonMrr: number;
  discountTotal: number;
  payingTenants: number;
  trialTenants: number;
  readOnlyTenants: number;
  byPlan: MrrPlanRow[];
  /**
   * Reconciliation: Σ of the append-only BillingEvent.amountDelta ledger. Tracks `mrr` for
   * tenants managed through the plans-as-data lifecycle (subscribe / change / add-on / scheduled
   * cancellation all emit signed deltas). NOTE: legacy Stripe-only churn
   * (billing.service onSubscriptionDeleted / suspendOverdueTenants) does not yet emit a
   * compensating delta, so ledgerMrr can drift above `mrr` for Stripe-cancelled tenants.
   */
  ledgerMrr: number;
  /** Net MRR change over the last 30 days (Σ amountDelta in that window). */
  momDelta: number;
}

/**
 * Server-side MRR rollup (Plans & Billing Phase 6). Prices from the per-tenant PRICE
 * SNAPSHOTS (basePriceSnapshot / addon priceSnapshot) so grandfathered pricing is
 * honoured, and reconciles the total against the append-only BillingEvent ledger.
 * MRR is a MONTHLY run-rate (annual subs count their monthly-equivalent snapshot).
 */
@Injectable()
export class MrrService {
  constructor(private readonly prisma: PrismaService) {}

  async computeOverview(): Promise<MrrOverview> {
    // Phase 0 T9: every query below scopes by tenant.class === "PRODUCTION" — the first
    // five customers are FREE PILOTS/TRIALS and every TEST/DEMO/INTERNAL tenant (routeflow-demo,
    // qa-*/e2e-*/ux-audit-* slugs, routeflow-hq) must be invisible to revenue everywhere,
    // not just here in the paying-subscription filter.
    const payingWhere = {
      planKey: { not: null },
      tenant: { status: "ACTIVE" as const, deletedAt: null, class: "PRODUCTION" as const },
    };
    const now = new Date();
    // Fixed trailing 30-day window. (Decrementing the month component instead overflows
    // short months — e.g. Date.UTC(y, 1, 31) rolls forward into March — silently dropping
    // in-window events on ~7 month-end days a year.)
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [subs, addons, trialTenants, readOnlyTenants, ledgerAgg, momAgg] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: payingWhere,
        select: { tenantId: true, planKey: true, basePriceSnapshot: true, discount: true },
      }),
      this.prisma.tenantAddon.findMany({
        // Mirror `payingWhere`: only count add-ons whose tenant has a PAYING base plan
        // (planKey != null). Otherwise an add-on on a plan-less ACTIVE tenant (e.g. a
        // manual/external-payment activation) would book add-on MRR with no base behind it.
        where: {
          active: true,
          tenant: {
            status: "ACTIVE",
            deletedAt: null,
            class: "PRODUCTION",
            subscription: { planKey: { not: null } },
          },
        },
        select: { tenantId: true, priceSnapshot: true, quantity: true },
      }),
      this.prisma.tenant.count({
        where: { status: "TRIAL", deletedAt: null, class: "PRODUCTION" },
      }),
      this.prisma.tenant.count({
        where: { status: "READ_ONLY", deletedAt: null, class: "PRODUCTION" },
      }),
      this.prisma.billingEvent.aggregate({
        _sum: { amountDelta: true },
        where: { tenant: { class: "PRODUCTION" } },
      }),
      this.prisma.billingEvent.aggregate({
        _sum: { amountDelta: true },
        where: { createdAt: { gte: monthAgo }, tenant: { class: "PRODUCTION" } },
      }),
    ]);

    // REG-743-N1 (L-119): group add-ons by tenant so each subscription's contribution is
    // priced through the exact same `priceSubscription()` a single tenant's card
    // (`priceTenant()`) calls — the platform total is a sum of per-tenant prices BY
    // CONSTRUCTION, not two independently-aggregated queries that can drift apart.
    const addonsByTenant = new Map<string, { priceSnapshot: unknown; quantity: number }[]>();
    for (const a of addons) {
      const list = addonsByTenant.get(a.tenantId) ?? [];
      list.push(a);
      addonsByTenant.set(a.tenantId, list);
    }

    let baseMrr = 0;
    let addonMrr = 0;
    let discountTotal = 0;
    let mrr = 0;
    const byPlanMap = new Map<string, { tenants: number; baseMrr: number }>();
    for (const s of subs) {
      const base = s.basePriceSnapshot != null ? Number(s.basePriceSnapshot) : 0;
      const discount = Number(s.discount ?? 0);
      const tenantAddons = addonsByTenant.get(s.tenantId) ?? [];
      const addonSum = tenantAddons.reduce(
        (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
        0,
      );
      baseMrr += base;
      discountTotal += discount;
      addonMrr += addonSum;
      mrr += this.priceSubscription(s, tenantAddons);
      const key = s.planKey as string;
      const row = byPlanMap.get(key) ?? { tenants: 0, baseMrr: 0 };
      row.tenants += 1;
      row.baseMrr = roundMoney(row.baseMrr + base - discount);
      byPlanMap.set(key, row);
    }

    baseMrr = roundMoney(baseMrr);
    const roundedAddon = roundMoney(addonMrr);
    const roundedDiscount = roundMoney(discountTotal);
    mrr = roundMoney(mrr);

    const byPlan: MrrPlanRow[] = [...byPlanMap.entries()]
      .map(([planKey, v]) => ({ planKey, tenants: v.tenants, baseMrr: v.baseMrr }))
      .sort((a, b) => b.baseMrr - a.baseMrr);

    return {
      mrr,
      baseMrr,
      addonMrr: roundedAddon,
      discountTotal: roundedDiscount,
      payingTenants: subs.length,
      trialTenants,
      readOnlyTenants,
      byPlan,
      ledgerMrr: roundMoney(Number(ledgerAgg._sum.amountDelta ?? 0)),
      momDelta: roundMoney(Number(momAgg._sum.amountDelta ?? 0)),
    };
  }

  /**
   * Pure per-row pricing: base snapshot − discount + Σ(addon price × qty), rounded. No
   * tenant/status/class gate — `computeOverview()` and `priceTenant()` both apply that
   * themselves, over rows already scoped to paying PRODUCTION tenants.
   */
  priceSubscription(
    sub: { basePriceSnapshot: unknown; discount?: unknown },
    addons: { priceSnapshot: unknown; quantity: number }[],
  ): number {
    const base = sub.basePriceSnapshot != null ? Number(sub.basePriceSnapshot) : 0;
    const discount = Number(sub.discount ?? 0);
    const addonSum = addons.reduce(
      (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
      0,
    );
    return roundMoney(base - discount + addonSum);
  }

  /**
   * REG-743-N1 (L-119): the one function a single tenant's admin-detail card prices through —
   * the SAME gate `computeOverview()` applies (non-PRODUCTION or non-ACTIVE → $0, no
   * exceptions; no subscription or no planKey → $0, never a catalog-price guess), so the card
   * and the platform-wide rollup can never diverge by construction. Replaces the retired
   * `_monthlyPriceUsd`/`_catalogPriceByPlanKey` catalog-fallback estimator.
   */
  async priceTenant(tenantId: string): Promise<number> {
    // Gate must match computeOverview()'s payingWhere EXACTLY (review finding) — it also
    // requires deletedAt: null. Without it, a soft-deleted tenant that a webhook later
    // flips back to ACTIVE (deletedAt untouched by that CAS) prices nonzero here while
    // still contributing $0 to the dashboard: the exact divergence this function exists
    // to close, just relocated.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        status: true,
        class: true,
        deletedAt: true,
        subscription: { select: { planKey: true, basePriceSnapshot: true, discount: true } },
      },
    });
    if (
      !tenant ||
      tenant.status !== "ACTIVE" ||
      tenant.class !== "PRODUCTION" ||
      tenant.deletedAt != null ||
      !tenant.subscription ||
      tenant.subscription.planKey == null
    ) {
      return 0;
    }
    const addons = await this.prisma.tenantAddon.findMany({
      where: { tenantId, active: true },
      select: { priceSnapshot: true, quantity: true },
    });
    return this.priceSubscription(tenant.subscription, addons);
  }
}
