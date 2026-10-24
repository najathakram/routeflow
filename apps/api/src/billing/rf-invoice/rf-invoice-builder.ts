import { BadRequestException, Injectable } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../../prisma/prisma.service";
import { billableAddonWhere } from "../addon-row";
import { annualPrice, cyclePrice, periodMonths, type Cycle } from "../billing-math";
import { PlatformPricingService } from "../platform-pricing.service";
import { windowParts, type WindowPart } from "./calendar-windows";
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

    // SA-744r2 M3: a window the calendar helper produces is priced by its parts (whole calendar months at
    // the full price, an alignment stretch prorated exactly). Any other shape keeps the length-based months
    // and is flagged IRREGULAR_PERIOD - a defensive notice, not normal flow.
    const parts = window ? windowParts(window.periodStart, window.periodEnd, cycle) : null;
    const legacy = parts ? null : windowMonths(cycle, window);
    const effectiveParts: WindowPart[] = parts ?? [{ kind: "FULL", months: legacy!.months }];
    const irregular = legacy?.irregular ?? false;

    const planUnit = roundMoney(cycle === "ANNUAL" ? resolved.annual : resolved.monthly);
    const planProrationUnit = cycle === "ANNUAL" ? resolved.annual / 12 : resolved.monthly;
    const lines: RfInvoiceLine[] = [];
    for (const part of effectiveParts) {
      lines.push(
        partLine(part, {
          kind: "PLAN",
          code: resolved.planKey,
          label: `${resolved.planName} plan (${cycle === "ANNUAL" ? "annual" : "monthly"})`,
          units: 1,
          fullUnit: planUnit,
          prorationUnit: planProrationUnit,
        }),
      );
    }

    const rows = await this.prisma.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId, active: true }),
      orderBy: { createdAt: "asc" },
    });
    let needsReview = irregular;
    for (const row of rows) {
      if (row.isComp) continue; // belt and braces: billableAddonWhere already excludes comps
      const code = row.sku ?? row.addonKey;
      if (row.priceSnapshot == null) {
        needsReview = true;
        // Units x months: a quarterly line of 2 units is quantity 6 at the monthly unit price.
        for (const part of effectiveParts) {
          lines.push(addonLine(code, part.kind === "FULL" ? row.quantity * part.months : 0, 0, 0));
        }
        continue;
      }
      // ONE formula for both cycles, the same as manual-activation-addons.ts (cycleAmount): the invoice
      // must equal what the other billing paths charge.
      const snapshot = Number(row.priceSnapshot);
      for (const part of effectiveParts) {
        lines.push(
          partLine(part, {
            kind: "ADDON",
            code,
            label: code,
            units: row.quantity,
            fullUnit: cyclePrice(snapshot, cycle),
            prorationUnit:
              cycle === "ANNUAL" ? annualPrice(snapshot) / 12 : cyclePrice(snapshot, cycle),
          }),
        );
      }
    }

    const total = roundMoney(lines.reduce((sum, l) => sum + l.amount, 0));
    return { ok: true, lines, total, needsReview, irregularPeriod: irregular, currency: "USD" };
  }
}

function addonLine(
  code: string,
  quantity: number,
  unitAmount: number,
  amount: number,
): RfInvoiceLine {
  return { kind: "ADDON", code, label: code, quantity, unitAmount, amount };
}

interface PartProduct {
  kind: RfInvoiceLine["kind"];
  code: string;
  label: string;
  /** Units of the product (an add-on's quantity; 1 for the plan). */
  units: number;
  /** The price of one unit for a whole billing month (ANNUAL: year), already rounded to cents. */
  fullUnit: number;
  /** The unit price an alignment stretch prorates: the monthly price (ANNUAL: annual / 12), unrounded. */
  prorationUnit: number;
}

/** Trim a day count to at most 4 decimals without trailing zeros (9.5, 2.5, 1.0417). */
function fmtDays(n: number): string {
  return String(Number(n.toFixed(4)));
}

/**
 * ONE line for one part of a window (L-167: every line of every invoice is priced here).
 * FULL: `roundMoney(unit x units x months)`. ALIGN (M3): ONE rounding per line,
 * `roundMoney(unit x units x daysRemaining / daysInCycle)` - never a rounded unit multiplied by qty. The
 * displayed quantity is the fraction of a unit (4 dp); the amount comes from the exact figures.
 */
function partLine(part: WindowPart, p: PartProduct): RfInvoiceLine {
  if (part.kind === "FULL") {
    const quantity = p.units * part.months;
    return {
      kind: p.kind,
      code: p.code,
      label: p.label,
      quantity,
      unitAmount: p.fullUnit,
      amount: roundMoney(p.fullUnit * quantity),
    };
  }
  const factor = part.daysRemaining / part.daysInCycle;
  return {
    kind: p.kind,
    code: p.code,
    label: `${p.label}, prorated ${fmtDays(part.daysRemaining)}/${fmtDays(part.daysInCycle)} days`,
    quantity: Number((p.units * factor).toFixed(4)),
    unitAmount: roundMoney(p.prorationUnit),
    amount: roundMoney(p.prorationUnit * p.units * factor),
  };
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
