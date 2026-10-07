import { BadRequestException, Injectable } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../../prisma/prisma.service";
import { billableAddonWhere } from "../addon-row";
import { cyclePrice, type Cycle } from "../billing-math";
import { PlatformPricingService } from "../platform-pricing.service";
import type { RfInvoiceLine } from "./rf-invoice.constants";

export type RfInvoiceDraft =
  | {
      ok: true;
      lines: RfInvoiceLine[];
      total: number;
      /** An add-on line had no price snapshot and was written at 0: the office must look at it. */
      needsReview: boolean;
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

  async build(tenantId: string, cycle: Cycle): Promise<RfInvoiceDraft> {
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

    const planAmount = roundMoney(cycle === "ANNUAL" ? resolved.annual : resolved.monthly);
    const lines: RfInvoiceLine[] = [
      {
        kind: "PLAN",
        code: resolved.planKey,
        label: `${resolved.planName} plan (${cycle === "ANNUAL" ? "annual" : "monthly"})`,
        quantity: 1,
        unitAmount: planAmount,
        amount: planAmount,
      },
    ];

    const rows = await this.prisma.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId, active: true }),
      orderBy: { createdAt: "asc" },
    });
    let needsReview = false;
    for (const row of rows) {
      if (row.isComp) continue; // belt and braces: billableAddonWhere already excludes comps
      const quantity = row.quantity;
      if (row.priceSnapshot == null) {
        needsReview = true;
        lines.push(addonLine(row, quantity, 0, 0));
        continue;
      }
      const price = Number(row.priceSnapshot);
      // Monthly multiplies the raw price (a half-cent snapshot rounds once, on the line); annual
      // multiplies the whole-cent 10-month price.
      const amount = roundMoney((cycle === "ANNUAL" ? cyclePrice(price, cycle) : price) * quantity);
      lines.push(addonLine(row, quantity, cyclePrice(price, cycle), amount));
    }

    const total = roundMoney(lines.reduce((sum, l) => sum + l.amount, 0));
    return { ok: true, lines, total, needsReview, currency: "USD" };
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
