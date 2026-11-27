import { BadRequestException, ConflictException } from "@nestjs/common";
import { planDisplayName } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";
import { lockTenantForLedger } from "./addon-ledger";
import { isInviteOnlyPlanKey, normalizePlanKey, planKeyToEnum } from "./plan-catalog.constants";
import type { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";
import { pinPlanVersionTx } from "./plan-version-pin";
import { priceOverrideOf } from "./price-override";

/**
 * SA-1547 PR-5: the plan pin a card-first checkout takes BEFORE it opens a session, and the one published-catalog check
 * a self-serve plan pick must pass (subscribe and the checkout pick both call it: no second copy of the rule).
 */

/** Custom (Enterprise) plans are negotiated, never self-service. */
export const CUSTOM_PLAN_MESSAGE = "Enterprise is a custom plan — contact sales.";

/** SA-1254 V7 (P-45): the invite-only refusal names the plan ("The Lite plan"), never its key. */
export function inviteOnlyRefusal(planKey: string): string {
  return `The ${planDisplayName(planKey) ?? "requested"} plan is available by invitation only — contact us.`;
}

/** A published key outside PLAN_KEYS has no name to show, so the refusal prints none (P-45). */
export const OFF_LADDER_PLAN_MESSAGE = "This plan can't be chosen here — contact support.";

export type PublishedPlanDef = PlanVersionWithCatalog["definitions"][number];

/** What the checkout asks the caller's eligibility gate: a session to pay, or a trial business picking its plan. */
export type CheckoutGateVerdict = "SESSION" | "TRIAL_PICK";
export interface CheckoutPick {
  planKey: string;
  /** Re-run by the checkout under its hold: throws the coded refusal, or says which of the two answers applies. */
  gate: () => Promise<CheckoutGateVerdict>;
}

/**
 * The published definition of a plan a self-serve caller may pick. Unknown, custom (ENTERPRISE), invite-only (LITE) and
 * off-ladder keys are a 400. With `code` the 400 carries it (the checkout pick); without it the body is the plain message
 * subscribe has always thrown.
 */
export function assertSelfServePlanDef(
  version: Pick<PlanVersionWithCatalog, "definitions">,
  planKey: string,
  code?: string,
): PublishedPlanDef {
  const bad = (message: string) => new BadRequestException(code ? { code, message } : message);
  const def = version.definitions.find((d) => d.planKey === planKey);
  if (!def) throw bad(`Unknown plan "${planKey}"`);
  if (def.isCustom) throw bad(CUSTOM_PLAN_MESSAGE);
  // S5/WP3a: LITE (and any future invite-only plan) can only be landed on via an explicit platform-admin action.
  if (isInviteOnlyPlanKey(planKey)) throw bad(inviteOnlyRefusal(planKey));
  // B218: a published key outside PLAN_KEYS must be a 400 here, not a 500 from planKeyToEnum() below.
  if (!normalizePlanKey(planKey)) throw bad(OFF_LADDER_PLAN_MESSAGE);
  return def;
}

/**
 * Re-pin a business onto `planKey` (plan, snapshot and catalog version) WITHOUT activating it: no status change, no
 * conversion stamp, no ledger row, no add-on row, no alert and no Stripe call. The CALLER holds the tenant-price lock
 * (this takes none); the write runs in its own transaction under the Tenant row lock, like `subscribeLocked`.
 * A quoted fee never moves: another plan is refused, the plan the business is on now is a no-op.
 */
export async function repinForSelfCheckoutTx(
  d: {
    prisma: Pick<PrismaService, "$transaction">;
    catalog: Pick<PlanCatalogService, "getPublishedCatalog">;
  },
  tenantId: string,
  planKey: string,
): Promise<{ planKey: string; planName: string; changed: boolean }> {
  const version = await d.catalog.getPublishedCatalog();
  const def = assertSelfServePlanDef(version, planKey, API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED);
  const planName = planDisplayName(planKey) ?? def.name;
  return d.prisma.$transaction(async (tx) => {
    await lockTenantForLedger(tx, tenantId);
    const [sub, tenant] = await Promise.all([
      tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: { planKey: true, priceOverrideMonthly: true },
      }),
      tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
    ]);
    const same = normalizePlanKey(sub?.planKey ?? tenant?.plan) === planKey;
    if (!same && priceOverrideOf(sub) != null) {
      throw new ConflictException({
        code: API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED,
        message: "Your plan has a quoted price. Ask us to change it.",
      });
    }
    if (same) return { planKey, planName, changed: false };
    const plan = {
      planKey,
      currentPlan: planKeyToEnum(planKey),
      basePriceSnapshot: def.monthlyPrice,
    };
    await tx.tenantSubscription.upsert({
      where: { tenantId },
      create: { tenantId, ...plan },
      update: plan,
    });
    await pinPlanVersionTx(tx, tenantId, version.id);
    return { planKey, planName, changed: true };
  });
}
