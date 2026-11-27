import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { planDisplayName, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";
import { isInviteOnlyPlanKey, normalizePlanKey } from "./plan-catalog.constants";
import type { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";
import { resolvePlanVersionId } from "./plan-version-pin";
import { priceOverrideOf } from "./price-override";

/**
 * SA-1547 PR-5 (SA-1319 R1 + R1a): a card-first plan pick. NOTHING is written before payment: the chosen plan, its catalog
 * version and its quoted price ride on the Checkout Session's metadata (and its terms hash), and the paid completion applies
 * them once. This file holds the READS a pick needs: the one published-catalog check a self-serve pick must pass (subscribe
 * calls it too: no second copy of the rule), the LITE and quoted-fee refusals, and the terms the offer is built from.
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

/** The session metadata keys that mark a pick session and carry its paid terms. */
export const PICK_META = {
  selfPick: "selfPick",
  planVersionId: "planVersionId",
  quotedMonthly: "quotedMonthly",
} as const;

/** What the checkout asks the caller's eligibility gate (it throws the coded refusal when the business may not pay). */
export interface CheckoutPick {
  planKey: string;
  gate: () => Promise<void>;
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
  const def = version.definitions.find((d) => d.planKey === planKey);
  if (!def) {
    throw new BadRequestException(
      code ? { code, message: `Unknown plan "${planKey}"` } : `Unknown plan "${planKey}"`,
    );
  }
  if (def.isCustom) {
    throw new BadRequestException(
      code ? { code, message: CUSTOM_PLAN_MESSAGE } : CUSTOM_PLAN_MESSAGE,
    );
  }
  // S5/WP3a: LITE (and any future invite-only plan) can only be landed on via an explicit platform-admin action.
  if (isInviteOnlyPlanKey(planKey)) {
    const message = inviteOnlyRefusal(planKey);
    throw new BadRequestException(code ? { code, message } : message);
  }
  // B218: a published key outside PLAN_KEYS must be a 400 here, not a 500 from planKeyToEnum() later.
  if (!normalizePlanKey(planKey)) {
    throw new BadRequestException(
      code ? { code, message: OFF_LADDER_PLAN_MESSAGE } : OFF_LADDER_PLAN_MESSAGE,
    );
  }
  return def;
}

/** What a pick resolves to, from reads only. */
export interface PickTerms {
  planKey: string;
  planName: string;
  /** The catalog version the paid completion pins: the pinned one for the current plan, else the published one. */
  planVersionId: string;
  /** The requested plan IS the plan the business is on: its pinned version, fee and add-ons apply (a price lock is honoured). */
  sameAsPinned: boolean;
  /** The published monthly price of a DIFFERENT plan (null when `sameAsPinned`: the pinned resolver prices that). */
  monthly: number | null;
}

/**
 * Read-only: refuses a pick the business may not make, and says what the offer must bill. LITE takes no planKey (400);
 * a business with a quoted fee may pick only the plan it is on (409). Writes nothing.
 */
export async function readPickTerms(
  d: {
    prisma: Pick<PrismaService, "tenant">;
    catalog: Pick<PlanCatalogService, "getPublishedCatalog" | "getVersionForTenant">;
  },
  tenantId: string,
  planKey: string,
): Promise<PickTerms> {
  const published = await d.catalog.getPublishedCatalog();
  const def = assertSelfServePlanDef(
    published,
    planKey,
    API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED,
  );
  const tenant = await d.prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      plan: true,
      planVersionId: true,
      subscription: {
        select: { planKey: true, planVersionId: true, priceOverrideMonthly: true },
      },
    },
  });
  if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);
  const sub = tenant.subscription;
  const current = normalizePlanKey(sub?.planKey ?? tenant.plan);
  // "LITE stays bodyless": an invited LITE business takes no planKey at all.
  if (isInviteOnlyPlanKey(current)) {
    throw new BadRequestException({
      code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED,
      message: OFF_LADDER_PLAN_MESSAGE,
    });
  }
  const planName = planDisplayName(planKey) ?? def.name;
  if (current === planKey) {
    const pinned = await d.catalog.getVersionForTenant(resolvePlanVersionId(sub, tenant));
    return { planKey, planName, planVersionId: pinned.id, sameAsPinned: true, monthly: null };
  }
  if (priceOverrideOf(sub) != null) {
    throw new ConflictException({
      code: API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED,
      message: "Your plan has a quoted price. Ask us to change it.",
    });
  }
  return {
    planKey,
    planName,
    planVersionId: published.id,
    sameAsPinned: false,
    monthly: roundMoney(Number(def.monthlyPrice)),
  };
}

/** The terms a PAID pick session carries, or null for any other session (today's bodyless ones complete as before). */
export function pickSessionTerms(
  metadata: Record<string, string | undefined> | null | undefined,
): { planKey: string; planVersionId: string; monthly: number } | null {
  if (metadata?.[PICK_META.selfPick] !== "1") return null;
  const planKey = metadata.planKey;
  const planVersionId = metadata[PICK_META.planVersionId];
  const monthly = Number(metadata[PICK_META.quotedMonthly]);
  if (!planKey || !planVersionId || !Number.isFinite(monthly) || monthly < 0) return null;
  return { planKey, planVersionId, monthly };
}
