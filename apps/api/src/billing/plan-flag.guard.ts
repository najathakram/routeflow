import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { EntitlementsService } from "./entitlements.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FeatureOverrideService } from "./feature-override.service";
import { REQUIRE_PLAN_FLAG_KEY } from "./require-plan-flag.decorator";
import { buildPlanGateBody } from "./plan-gate";
import { isDarkFlag } from "./plan-flag-policy";
import { EntitlementAuthority } from "./entitlement-authority.service";

/** No self-service fix exists for an admin override — an upgrade CTA would be misleading. */
const NO_UPGRADE = {
  planKey: null,
  planMonthlyPrice: null,
  addonSku: null,
  addonMonthlyPrice: null,
};

/**
 * Re-exported for existing consumers/docs (CLAUDE.md's Entitlement gates section) that
 * still point at this module — the set itself now lives in plan-flag-policy.ts
 * alongside the rest of the dark-flag policy (isDarkFlag/allowsFlag), which also needs
 * it and must not import it back from here.
 */
export { DARK_PLAN_FLAGS } from "./plan-flag-policy";

/**
 * Enforces @RequirePlanFlag(flagKey). Mirrors AddonGuard's contract:
 * `@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)` — guards run BEFORE the
 * TenantInterceptor, so the tenant AsyncLocalStorage is NOT initialized here; read
 * tenantId from `req.user` (populated by JwtAuthGuard), never from prisma.getTenantId().
 *
 * SERVER IS THE AUTHORITY: the flag is re-resolved from EntitlementsService (DB-backed,
 * cached), NOT read from the JWT claims — a stale/forged claim can never unlock behavior.
 * On denial it throws a structured PLAN_GATE 403 (see plan-gate.ts).
 *
 * Feature grants v2 brief A (design 2026-09-17 §2): a single flagKey is exactly the shape
 * `EntitlementAuthority.can()` decides, so the whole override/dark-flag/resolve-and-allow
 * chain now lives there (byte-identical in shadow mode — see
 * entitlement-authority.service.spec.ts's shadow-parity oracle) instead of being duplicated
 * here. This guard keeps only the HTTP-shaped concerns: the 403 body and the dark-flag deny
 * log, which `can()`'s plain boolean can't carry.
 */
@Injectable()
export class PlanFlagGuard implements CanActivate {
  private readonly logger = new Logger(PlanFlagGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
    private readonly catalog: PlanCatalogService,
    private readonly featureOverrides: FeatureOverrideService,
    private readonly authority: EntitlementAuthority,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flagKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PLAN_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flagKey) return true;

    const request = context.switchToHttp().getRequest<{ user?: { tenantId?: string | null } }>();
    const tenantId = request.user?.tenantId ?? null;
    // SUPER_ADMIN operates without a tenant — never plan-gated. Checked BEFORE the
    // dark-flag policy (R3a.5): there is no tenant to resolve a plan for.
    if (tenantId == null) return true;

    if (await this.authority.can(tenantId, flagKey)) return true;

    // Denial: reconstruct which branch fired, purely to shape the right 403 — can() already
    // made the decision, this never changes it.
    const override = await this.featureOverrides.get(tenantId, flagKey);
    if (override === "DENY") {
      if (isDarkFlag(flagKey)) {
        this.logger.warn(
          `plan flag gate override-denied on a dark flag: flag=${flagKey} tenant=${tenantId}`,
        );
      }
      throw new ForbiddenException(buildPlanGateBody(flagKey, NO_UPGRADE));
    }

    try {
      await this.entitlements.resolve(tenantId);
    } catch (err) {
      this.logger.error(`Entitlement resolution failed for tenant ${tenantId}`, err as Error);
      throw new ForbiddenException({
        code: "PLAN_GATE_UNAVAILABLE",
        message: "Entitlements are temporarily unavailable. Please retry.",
      });
    }

    const upgrade = await this.catalog.upgradeTargetForFlag(flagKey).catch(() => ({
      planKey: null,
      planMonthlyPrice: null,
      addonSku: null,
      addonMonthlyPrice: null,
    }));
    throw new ForbiddenException(buildPlanGateBody(flagKey, upgrade));
  }
}
