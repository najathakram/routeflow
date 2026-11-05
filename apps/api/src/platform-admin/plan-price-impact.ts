import { BadRequestException, ConflictException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";

/** The ceiling the price form and `UpdatePlanPricesDto` share in spirit: nothing above this is a real plan price. */
export const PLAN_PRICE_IMPACT_MAX_MONTHLY = 100000;

/**
 * SA-1100 §2: `body.code` of the 409 a plan price edit answers when the number of businesses it would re-price is no
 * longer the number the admin confirmed (`expectedAffected`). Nothing was changed; the dialog fetches the count again.
 * Kept here, not in the shared `API_ERROR_CODES` list: the one client is the platform-admin plans page, which matches
 * the same literal from `lib/api/platform-pricing.ts`. (Move both into `packages/types/api/error-codes.ts` when that
 * package can be rebuilt in a tree of its own.)
 */
export const PLAN_PRICE_IMPACT_CHANGED = "PLAN_PRICE_IMPACT_CHANGED";

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
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > PLAN_PRICE_IMPACT_MAX_MONTHLY ||
    // at most 2 decimals: a price that rounds to cents is itself (no bare `* 100`, SA-733 D9)
    roundMoney(value) !== value
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
/**
 * THE count of businesses a plan price edit re-prices: the targets minus those whose scheduled-downgrade price is
 * already pushed to Stripe. The impact read, the PATCH's re-check and (by construction) the PATCH's own `updated`
 * all use this one definition.
 */
export async function countAffectedTargets(
  targets: ReadonlyArray<{ tenantId: string; downgradeToPlanKey?: string | null }>,
  downgradePushed: (tenantId: string) => Promise<boolean>,
): Promise<number> {
  let skipped = 0;
  for (const t of targets) {
    if (t.downgradeToPlanKey && (await downgradePushed(t.tenantId))) skipped++;
  }
  return targets.length - skipped;
}

/** SA-1100 §2: the 409 for a confirmed count that no longer holds. `affected` is the CURRENT count. */
export function planPriceImpactChanged(
  expectedAffected: number | undefined,
  affected: number,
): ConflictException {
  return new ConflictException({
    code: PLAN_PRICE_IMPACT_CHANGED,
    message: "The number of businesses this price change affects has changed. Check it again.",
    expectedAffected: expectedAffected ?? null,
    affected,
  });
}

export async function buildPlanPriceImpact(a: {
  planKey: string;
  currentMonthly: number;
  newMonthly: number;
  targets: ReadonlyArray<{ tenantId: string; downgradeToPlanKey?: string | null }>;
  ownPrice: number;
  /** Same expression the PATCH uses: `(await scheduledPrice?.isDowngradePricePushed(id)) ?? true`. */
  downgradePushed: (tenantId: string) => Promise<boolean>;
}): Promise<PlanPriceImpact> {
  const affected = await countAffectedTargets(a.targets, a.downgradePushed);
  return {
    planKey: a.planKey,
    currentMonthly: a.currentMonthly,
    newMonthly: a.newMonthly,
    affected,
    ownPrice: a.ownPrice,
    monthlyDelta: roundMoney((a.newMonthly - a.currentMonthly) * affected),
  };
}
