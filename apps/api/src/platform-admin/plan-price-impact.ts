import { BadRequestException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";

/** The ceiling the price form and `UpdatePlanPricesDto` share in spirit: nothing above this is a real plan price. */
export const PLAN_PRICE_IMPACT_MAX_MONTHLY = 100000;

/** R24: what the platform-admin price confirm shows before a catalog price is saved. */
export interface PlanPriceImpact {
  planKey: string;
  currentMonthly: number;
  newMonthly: number;
  /** Businesses the price edit's fan-out would re-price: exactly the PATCH's `updated`. */
  affected: number;
  /** Businesses on this plan with their own monthly price: not touched by the edit. */
  ownPrice: number;
  /** `roundMoney((newMonthly - currentMonthly) * affected)`: the change in what is billed each month. */
  monthlyDelta: number;
}

/** The `monthly` query value as a price, or a 400. The same shape the PATCH body accepts (>= 0, 2 decimals). */
export function parseImpactMonthly(raw: unknown): number {
  const text = typeof raw === "string" ? raw.trim() : "";
  const value = text === "" ? NaN : Number(text);
  const cents = Math.round(value * 100);
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > PLAN_PRICE_IMPACT_MAX_MONTHLY ||
    Math.abs(value * 100 - cents) > 1e-6
  ) {
    throw new BadRequestException(
      "monthly must be a price between 0 and 100000 with at most 2 decimals",
    );
  }
  return value;
}

/**
 * Builds the answer from the SAME selection the PATCH fans out over. A tenant whose scheduled downgrade price is
 * already pushed to Stripe is skipped by the PATCH (under its lock, from a fresh read); the same read is made here so
 * the count cannot promise a business the PATCH then leaves alone. Read-only: no write, no Stripe, no audit row.
 */
export async function buildPlanPriceImpact(a: {
  planKey: string;
  currentMonthly: number;
  newMonthly: number;
  targets: ReadonlyArray<{ tenantId: string; downgradeToPlanKey?: string | null }>;
  ownPrice: number;
  /** Same expression the PATCH uses: `(await scheduledPrice?.isDowngradePricePushed(id)) ?? true`. */
  downgradePushed: (tenantId: string) => Promise<boolean>;
}): Promise<PlanPriceImpact> {
  let skipped = 0;
  for (const t of a.targets) {
    if (t.downgradeToPlanKey && (await a.downgradePushed(t.tenantId))) skipped++;
  }
  const affected = a.targets.length - skipped;
  return {
    planKey: a.planKey,
    currentMonthly: a.currentMonthly,
    newMonthly: a.newMonthly,
    affected,
    ownPrice: a.ownPrice,
    monthlyDelta: roundMoney((a.newMonthly - a.currentMonthly) * affected),
  };
}
