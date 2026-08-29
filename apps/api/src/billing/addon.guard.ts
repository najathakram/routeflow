import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AddonService } from "./addon.service";
import { REQUIRE_ADDON_KEY } from "./require-addon.decorator";

/**
 * Addon keys that are internal platform-admin switches rather than purchasable add-ons.
 * They are honoured as any-of keys but NEVER named in the 403 message — the web toasts
 * that message verbatim (MutationCache.onError), so echoing them would leak a hidden flag
 * and give tenants upgrade guidance they cannot act on. String literals on purpose: API
 * source never imports @routeflow/types at runtime.
 */
const INTERNAL_ADDON_KEYS = new Set(["developer_mode"]);

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
    // Metadata is either the legacy single string (from a call site that hasn't been
    // touched) or the current string[] from the variadic @RequireAddon(...keys).
    const raw = this.reflector.getAllAndOverride<string | string[] | undefined>(REQUIRE_ADDON_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const keys = typeof raw === "string" ? [raw] : raw;
    if (!keys || keys.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: { tenantId?: string | null } }>();
    const tenantId = request.user?.tenantId ?? null;
    // SUPER_ADMIN operates without a tenant — never addon-gated
    if (tenantId == null) return true;

    const active = await this.addonService.getActiveAddons(tenantId); // one query for any-of
    if (keys.some((k) => active.includes(k))) return true;
    // Name only the purchasable keys; internal flags stay out of tenant-facing text.
    const named = keys.filter((k) => !INTERNAL_ADDON_KEYS.has(k));
    const quoted = named.map((k) => `"${k}"`).join(", ");
    throw new ForbiddenException(
      named.length === 0
        ? "This feature is not enabled for your account."
        : named.length === 1
          ? `This feature requires the ${quoted} add-on.`
          : `This feature requires one of these add-ons: ${quoted}.`,
    );
  }
}
