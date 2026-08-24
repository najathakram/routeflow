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
import { REQUIRE_PLAN_FLAG_KEY } from "./require-plan-flag.decorator";
import { buildPlanGateBody } from "./plan-gate";

/**
 * Flags whose server-side enforcement the 2026-08-23 rollout introduces — these,
 * and ONLY these, are muted by the PLAN_FLAG_ENFORCEMENT kill switch. Any gate
 * not listed here was already live before the switch existed (flag.msrp, shipped
 * in #411) and must keep enforcing regardless of the env. REMOVE this set along
 * with the switch by 2026-10-01.
 */
const DARK_PLAN_FLAGS = new Set([
  "flag.analytics",
  "flag.ap_bills",
  "flag.import_integrations",
  "flag.forecasting",
  "flag.pricing_tiers",
  "flag.reports",
  "flag.returns",
]);

/**
 * Enforces @RequirePlanFlag(flagKey). Mirrors AddonGuard's contract:
 * `@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)` — guards run BEFORE the
 * TenantInterceptor, so the tenant AsyncLocalStorage is NOT initialized here; read
 * tenantId from `req.user` (populated by JwtAuthGuard), never from prisma.getTenantId().
 *
 * SERVER IS THE AUTHORITY: the flag is re-resolved from EntitlementsService (DB-backed,
 * cached), NOT read from the JWT claims — a stale/forged claim can never unlock behavior.
 * On denial it throws a structured PLAN_GATE 403 (see plan-gate.ts).
 */
@Injectable()
export class PlanFlagGuard implements CanActivate {
  private readonly logger = new Logger(PlanFlagGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
    private readonly catalog: PlanCatalogService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flagKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PLAN_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flagKey) return true;

    // Release toggle (REMOVE by 2026-10-01): the gates added by the 2026-08-23
    // rollout ship dark. "on" = enforce; anything else = allow. Scoped to
    // DARK_PLAN_FLAGS so gates that were already live (flag.msrp) keep enforcing.
    // The owner flips this on only after the prod entitlement audit
    // (scripts/audit-tenant-entitlements.mjs) proves no live tenant loses a
    // surface it uses today.
    if (DARK_PLAN_FLAGS.has(flagKey) && (process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on") {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: { tenantId?: string | null } }>();
    const tenantId = request.user?.tenantId ?? null;
    // SUPER_ADMIN operates without a tenant — never plan-gated.
    if (tenantId == null) return true;

    let allowed: boolean;
    try {
      allowed = await this.entitlements.hasFlag(tenantId, flagKey);
    } catch (err) {
      // Entitlement resolution failed (DB down / unseeded catalog). FAIL CLOSED —
      // deny with a stable, distinguishable error rather than leaking a raw 500/404.
      this.logger.error(`Entitlement resolution failed for tenant ${tenantId}`, err as Error);
      throw new ForbiddenException({
        code: "PLAN_GATE_UNAVAILABLE",
        message: "Entitlements are temporarily unavailable. Please retry.",
      });
    }
    if (allowed) return true;

    const upgrade = await this.catalog.upgradeTargetForFlag(flagKey).catch(() => ({
      planKey: null,
      planMonthlyPrice: null,
      addonSku: null,
      addonMonthlyPrice: null,
    }));
    throw new ForbiddenException(buildPlanGateBody(flagKey, upgrade));
  }
}
