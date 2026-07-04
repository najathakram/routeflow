import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AddonService } from "./addon.service";
import { REQUIRE_ADDON_KEY } from "./require-addon.decorator";

/**
 * Enforces @RequireAddon(key). Guard order matters:
 * `@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)` — guards run BEFORE the
 * TenantInterceptor, so the tenant AsyncLocalStorage is NOT initialized here;
 * read the tenantId from `req.user` (populated by JwtAuthGuard), never from
 * `prisma.getTenantId()`.
 */
@Injectable()
export class AddonGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly addonService: AddonService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const addonKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_ADDON_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!addonKey) return true;

    const request = context.switchToHttp().getRequest<{ user?: { tenantId?: string | null } }>();
    const tenantId = request.user?.tenantId ?? null;
    // SUPER_ADMIN operates without a tenant — never addon-gated
    if (tenantId == null) return true;

    if (await this.addonService.hasAddon(tenantId, addonKey)) return true;
    throw new ForbiddenException(`This feature requires the "${addonKey}" add-on.`);
  }
}
