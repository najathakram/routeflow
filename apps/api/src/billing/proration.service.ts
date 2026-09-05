import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { roundMoney } from "@routeflow/pricing";
import { annualSaving, cyclePrice, daysBetween, prorateDaily, Cycle } from "./billing-math";
import { planRank } from "./plan-catalog.constants";

/**
 * Plan ordering for "included at plan and above" checks. Goes through `planRank`
 * so historical keys stored on superseded catalog versions (TEAM/BUSINESS) rank
 * alongside their current equivalents instead of falling off the ladder.
 */
function rankOrDefault(planKey: string, fallback: number): number {
  const rank = planRank(planKey);
  return rank < 0 ? fallback : rank;
}

export interface QuoteRequest {
  planKey: string;
  cycle: Cycle;
  addons?: Array<{ sku: string; quantity?: number }>;
}

export interface QuoteLine {
  type: "plan" | "addon";
  key: string;
  name: string;
  quantity: number;
  /** Monthly run-rate for this line (0 when bundled free at the plan). */
  monthly: number;
  /** What this line costs for the chosen cycle (monthly, or ×10 for annual). */
  cyclePrice: number;
  included: boolean;
}

export interface Quote {
  planKey: string;
  planName: string;
  cycle: Cycle;
  isCustom: boolean;
  lines: QuoteLine[];
  subtotalMonthly: number;
  dueToday: number;
  annualSaving: number;
  renewalAt: string;
}

export interface ProrationPreview {
  sku: string;
  name: string;
  monthly: number;
  proratedToday: number;
  daysRemaining: number;
  daysInCycle: number;
  effectiveAt: string;
  nextChargeAt: string;
}

/**
 * Server-authoritative subscription pricing: quotes for the choose-plan chooser and
 * mid-cycle add-on proration previews. Upgrades are instant + prorated; downgrades
 * are scheduled at period end (no proration/credit) — the latter is applied by the
 * Phase-4 mutation endpoints. All money is routed through billing-math / roundMoney.
 */
@Injectable()
export class ProrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: PlanCatalogService,
  ) {}

  /** Price a plan + add-on selection at a cycle (fresh-subscription / plan-change quote). */
  async quote(req: QuoteRequest): Promise<Quote> {
    const version = await this.catalog.getPublishedCatalog();
    const def = version.definitions.find((d) => d.planKey === req.planKey);
    if (!def) throw new BadRequestException(`Unknown plan "${req.planKey}"`);
    const cycle: Cycle = req.cycle === "ANNUAL" ? "ANNUAL" : "MONTHLY";

    const lines: QuoteLine[] = [];

    const planMonthly = def.monthlyPrice != null ? Number(def.monthlyPrice) : 0;
    lines.push({
      type: "plan",
      key: def.planKey,
      name: def.name,
      quantity: 1,
      monthly: roundMoney(planMonthly),
      cyclePrice: def.isCustom ? 0 : cyclePrice(planMonthly, cycle),
      included: false,
    });

    const skuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));
    const seen = new Set<string>();
    for (const a of req.addons ?? []) {
      const sku = skuByCode.get(a.sku);
      if (!sku) throw new BadRequestException(`Unknown add-on "${a.sku}"`);
      if (seen.has(sku.sku)) throw new BadRequestException(`Duplicate add-on "${sku.sku}"`);
      seen.add(sku.sku);
      const qty = Math.max(1, Math.trunc(a.quantity ?? 1));
      const includedFree =
        !!sku.includedAtPlan &&
        rankOrDefault(req.planKey, 0) >= rankOrDefault(sku.includedAtPlan, Number.MAX_SAFE_INTEGER);
      const unitMonthly = Number(sku.monthlyPrice);
      const lineMonthly = unitMonthly * qty;
      lines.push({
        type: "addon",
        key: sku.sku,
        name: sku.name,
        quantity: qty,
        monthly: includedFree ? 0 : roundMoney(lineMonthly),
        cyclePrice: includedFree ? 0 : cyclePrice(lineMonthly, cycle),
        included: includedFree,
      });
    }

    const subtotalMonthly = roundMoney(lines.reduce((s, l) => s + l.monthly, 0));
    const dueToday = def.isCustom ? 0 : roundMoney(lines.reduce((s, l) => s + l.cyclePrice, 0));
    const saving =
      cycle === "ANNUAL"
        ? roundMoney(lines.reduce((s, l) => s + (l.included ? 0 : annualSaving(l.monthly)), 0))
        : 0;

    const now = new Date();
    const renewal = new Date(now);
    if (cycle === "ANNUAL") renewal.setUTCFullYear(now.getUTCFullYear() + 1);
    else renewal.setUTCMonth(now.getUTCMonth() + 1);

    return {
      planKey: def.planKey,
      planName: def.name,
      cycle,
      isCustom: def.isCustom,
      lines,
      subtotalMonthly,
      dueToday,
      annualSaving: saving,
      renewalAt: renewal.toISOString(),
    };
  }

  /** The mid-cycle prorated charge to enable an add-on today (INLINE_RESOLVE modal). */
  async prorationPreview(tenantId: string, skuCode: string): Promise<ProrationPreview> {
    const version = await this.catalog.getPublishedCatalog();
    const sku = version.addonSkus.find((s) => s.sku === skuCode);
    if (!sku) throw new BadRequestException(`Unknown add-on "${skuCode}"`);

    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { cycle: true, periodStart: true, periodEnd: true },
    });
    const now = new Date();

    // Add-ons are MONTHLY-priced, so the proration window is always ~one month:
    // the subscription period ONLY when it is a MONTHLY cycle (≈30 days), otherwise
    // the current calendar month. Never the full ANNUAL period — dividing a monthly
    // rate by ~365 days would ~12× undercharge annual-plan tenants.
    let windowStart: Date;
    let windowEnd: Date;
    if (
      sub?.cycle === "MONTHLY" &&
      sub.periodStart &&
      sub.periodEnd &&
      sub.periodStart <= now &&
      now < sub.periodEnd
    ) {
      windowStart = sub.periodStart;
      windowEnd = sub.periodEnd;
    } else {
      windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }

    // Charge a CONTINUOUS fraction of the window (ms-precise) rather than ceil'd
    // whole days — so an enable near the period edge is not rounded up to a full day.
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const msInWindow = windowEnd.getTime() - windowStart.getTime();
    const msRemaining = Math.max(0, Math.min(msInWindow, windowEnd.getTime() - now.getTime()));
    const monthly = Number(sku.monthlyPrice);

    return {
      sku: sku.sku,
      name: sku.name,
      monthly: roundMoney(monthly),
      proratedToday: prorateDaily(monthly, msRemaining / MS_PER_DAY, msInWindow / MS_PER_DAY),
      daysRemaining: Math.round(msRemaining / MS_PER_DAY),
      daysInCycle: daysBetween(windowStart, windowEnd),
      effectiveAt: now.toISOString(),
      nextChargeAt: windowEnd.toISOString(),
    };
  }
}
