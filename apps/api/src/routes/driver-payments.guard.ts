import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { AddonService } from "../billing/addon.service";

// Literal, matching tobacco.controller's "tobacco_dealer" style — the API
// deliberately never imports @routeflow/types at runtime (pinned by
// common/no-runtime-workspace-imports.spec.ts). Clients read the mirrored
// DRIVER_PAYMENTS_ADDON constant from packages/types.
const DRIVER_PAYMENTS_ADDON = "driver_payments";

/**
 * At-door money collection is a per-tenant OPT-IN (owner decision 2026-08-24:
 * affa collects at the door, bb-distro bills on account and the office
 * collects). This guard sits on POST /route-runs/:id/stops/:stopId/
 * complete-with-payment and inspects the BODY rather than blanket-gating the
 * route: every mobile completion — including the $0 "on account" close — uses
 * that endpoint for its delivered-basis invoice reconcile, so a completion
 * carrying no payment (or amount <= 0, which RF-006 separately rejects for
 * cash-like methods) must keep working for every tenant. Only an actual
 * collection (payment.amount > 0) requires the "driver_payments" TenantAddon.
 *
 * Runs AFTER JwtAuthGuard (class level) so req.user is populated; like
 * AddonGuard it must read tenantId from req.user, never prisma.getTenantId()
 * (guards run before the TenantInterceptor initializes AsyncLocalStorage).
 * SUPER_ADMIN (tenantId null) is never gated.
 */
@Injectable()
export class DriverPaymentsGuard implements CanActivate {
  constructor(private readonly addonService: AddonService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: { tenantId?: string | null };
      body?: { payment?: { amount?: unknown } };
    }>();

    const amount = Number(request.body?.payment?.amount ?? 0);
    if (!(amount > 0)) return true;

    const tenantId = request.user?.tenantId ?? null;
    if (tenantId == null) return true;

    if (await this.addonService.hasAddon(tenantId, DRIVER_PAYMENTS_ADDON)) return true;
    throw new ForbiddenException(
      "At-door payment collection is not enabled for this workspace. Complete the stop on account instead — the office records the payment.",
    );
  }
}
