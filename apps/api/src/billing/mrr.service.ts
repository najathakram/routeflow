import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";

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
    const payingWhere = {
      planKey: { not: null },
      tenant: { status: "ACTIVE" as const, deletedAt: null },
    };
    const now = new Date();
    // Fixed trailing 30-day window. (Decrementing the month component instead overflows
    // short months — e.g. Date.UTC(y, 1, 31) rolls forward into March — silently dropping
    // in-window events on ~7 month-end days a year.)
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [subs, addons, trialTenants, readOnlyTenants, ledgerAgg, momAgg] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: payingWhere,
        select: { planKey: true, basePriceSnapshot: true, discount: true },
      }),
      this.prisma.tenantAddon.findMany({
        // Mirror `payingWhere`: only count add-ons whose tenant has a PAYING base plan
        // (planKey != null). Otherwise an add-on on a plan-less ACTIVE tenant (e.g. a
        // manual/external-payment activation) would book add-on MRR with no base behind it.
        where: {
          active: true,
          tenant: { status: "ACTIVE", deletedAt: null, subscription: { planKey: { not: null } } },
        },
        select: { priceSnapshot: true, quantity: true },
      }),
      this.prisma.tenant.count({ where: { status: "TRIAL", deletedAt: null } }),
      this.prisma.tenant.count({ where: { status: "READ_ONLY", deletedAt: null } }),
      this.prisma.billingEvent.aggregate({ _sum: { amountDelta: true } }),
      this.prisma.billingEvent.aggregate({
        _sum: { amountDelta: true },
        where: { createdAt: { gte: monthAgo } },
      }),
    ]);

    let baseMrr = 0;
    let discountTotal = 0;
    const byPlanMap = new Map<string, { tenants: number; baseMrr: number }>();
    for (const s of subs) {
      const base = s.basePriceSnapshot != null ? Number(s.basePriceSnapshot) : 0;
      const discount = Number(s.discount ?? 0);
      baseMrr += base;
      discountTotal += discount;
      const key = s.planKey as string;
      const row = byPlanMap.get(key) ?? { tenants: 0, baseMrr: 0 };
      row.tenants += 1;
      row.baseMrr = roundMoney(row.baseMrr + base - discount);
      byPlanMap.set(key, row);
    }

    const addonMrr = addons.reduce(
      (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
      0,
    );

    baseMrr = roundMoney(baseMrr);
    const roundedAddon = roundMoney(addonMrr);
    const roundedDiscount = roundMoney(discountTotal);
    const mrr = roundMoney(baseMrr + roundedAddon - roundedDiscount);

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
}
