import { SetMetadata } from "@nestjs/common";

export const REQUIRE_PLAN_FLAG_KEY = "requirePlanFlag";

/**
 * Gate a controller/handler on a plan feature flag (one of the 16 keys in
 * pricing-plans.md, e.g. "flag.reports", "addon.buyer_portal"). Enforced by
 * {@link PlanFlagGuard}, which must be listed AFTER JwtAuthGuard in @UseGuards so
 * `req.user.tenantId` is populated.
 *
 * On failure the guard returns a structured PLAN_GATE 403 the web renders as an
 * upsell page (LOCKED_PAGE) or an inline add-on enable (INLINE_RESOLVE). SUPER_ADMIN
 * (tenantId === null) always passes.
 *
 * @example
 *   @UseGuards(JwtAuthGuard, PlanFlagGuard)
 *   @RequirePlanFlag("flag.reports")
 *   @Get("reports/ar-aging")
 */
export const RequirePlanFlag = (flagKey: string) => SetMetadata(REQUIRE_PLAN_FLAG_KEY, flagKey);
