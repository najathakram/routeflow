import { BadRequestException, Injectable } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../../prisma/prisma.service";
import { billableAddonWhere } from "../addon-row";
import { cyclePrice, periodMonths, type Cycle } from "../billing-math";
import { PlatformPricingService } from "../platform-pricing.service";
import type { RfInvoiceLine } from "./rf-invoice.constants";

export type RfInvoiceDraft =
  | {
      ok: true;
      lines: RfInvoiceLine[];
      total: number;
      /** An add-on line had no price snapshot and was written at 0: the office must look at it. */
      needsReview: boolean;
      /** The window is not a whole number of months (MONTHLY) or not 365/366 days (ANNUAL): issued, flagged. */
      irregularPeriod: boolean;
      currency: "USD";
    }
  | { ok: false; reason: "NO_PRICE"; message: string };

/**
 * Builds the lines and total of one manual-pay RouteFlow invoice. Pure of side effects: the issuer
 * persists it. Plan line = the tenant's resolved price for its cycle; add-on lines = the tenant's
 * ACTIVE, non-comp add-on rows at their price snapshot. Feature overrides are never lines. No tax.
 */
@Injectable()
export class RfInvoiceBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PlatformPricingService,
  ) {}

  /**
   * `window` is the period being invoiced. A MONTHLY row can cover several months (manual activation
   * allows any billing period, e.g. 90 days = quarterly), so every MONTHLY line is multiplied by
   * `periodMonths(start, end)` (SA-383, the helper proration uses). An irregular window is still
   * invoiced - never guessed silently - but flagged `needsReview` + `irregularPeriod`.
   */
  async build(
    tenantId: string,
    cycle: Cycle,
    window?: { periodStart: Date; periodEnd: Date },
  ): Promise<RfInvoiceDraft> {
    let resolved;
    try {
      resolved = await this.pricing.resolveTenantPricing(tenantId);
    } catch (e) {
      // Only "no resolvable price" (BadRequest) is a tenant data problem; anything else is infrastructure.
      if (e instanceof BadRequestException) {
        return { ok: false, reason: "NO_PRICE", message: e.message };
      }
      throw e;
    }

    const { months, irregular } = windowMonths(cycle, window);
    const planUnit = roundMoney(cycle === "ANNUAL" ? resolved.annual : resolved.monthly);
    // Unit first, then x months - the same rounding order as the add-on rule below.
    const planAmount = roundMoney(planUnit * months);
    const lines: RfInvoiceLine[] = [
      {
        kind: "PLAN",
        code: resolved.planKey,
        label: `${resolved.planName} plan (${cycle === "ANNUAL" ? "annual" : "monthly"})`,
        quantity: months,
        unitAmount: planUnit,
        amount: planAmount,
      },
    ];

    const rows = await this.prisma.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId, active: true }),
      orderBy: { createdAt: "asc" },
    });
    let needsReview = irregular;
    for (const row of rows) {
      if (row.isComp) continue; // belt and braces: billableAddonWhere already excludes comps
      // Units x months: a quarterly line of 2 units is quantity 6 at the monthly unit price.
      const quantity = row.quantity * months;
      if (row.priceSnapshot == null) {
        needsReview = true;
        lines.push(addonLine(row, quantity, 0, 0));
        continue;
      }
      // ONE formula for both cycles, the same as manual-activation-addons.ts (cycleAmount): the invoice
      // must equal what the other billing paths charge.
      const unit = cyclePrice(Number(row.priceSnapshot), cycle);
      const amount = roundMoney(unit * quantity);
      lines.push(addonLine(row, quantity, unit, amount));
    }

    const total = roundMoney(lines.reduce((sum, l) => sum + l.amount, 0));
    return { ok: true, lines, total, needsReview, irregularPeriod: irregular, currency: "USD" };
  }
}

function addonLine(
  row: { sku: string | null; addonKey: string },
  quantity: number,
  unitAmount: number,
  amount: number,
): RfInvoiceLine {
  const code = row.sku ?? row.addonKey;
  return { kind: "ADDON", code, label: code, quantity, unitAmount, amount };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Months per 365.25-day year / 12 - the divisor behind `periodMonths`, used only to judge "whole". */
const DAYS_PER_MONTH = 365.25 / 12;
/** A window within this many months of a whole number counts as whole (30/31/28-day months, 90/180 days). */
const WHOLE_MONTH_TOLERANCE = 0.15;

/** How many cycle units a window covers, and whether the window is irregular (never guessed silently). */
function windowMonths(
  cycle: Cycle,
  window?: { periodStart: Date; periodEnd: Date },
): { months: number; irregular: boolean } {
  if (!window) return { months: 1, irregular: false };
  const days = (window.periodEnd.getTime() - window.periodStart.getTime()) / DAY_MS;
  if (cycle === "ANNUAL") {
    const d = Math.round(days);
    return { months: 1, irregular: !(d === 365 || d === 366) };
  }
  const exact = days / DAYS_PER_MONTH;
  return {
    months: periodMonths(window.periodStart, window.periodEnd),
    irregular: Math.abs(exact - Math.round(exact)) > WHOLE_MONTH_TOLERANCE || exact < 0.5,
  };
}
