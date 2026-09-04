import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AddonService } from "./addon.service";
import { REQUIRE_ADDON_KEY } from "./require-addon.decorator";
import { addonGateState } from "./addon-gate-registry";

/**
 * Addon keys that are internal platform-admin switches rather than purchasable add-ons.
 * They are honoured as any-of keys but NEVER named in the 403 message — the web toasts
 * that message verbatim (MutationCache.onError), so echoing them would leak a hidden flag
 * and give tenants upgrade guidance they cannot act on. String literals on purpose: API
 * source never imports @routeflow/types at runtime.
 */
const INTERNAL_ADDON_KEYS = new Set(["developer_mode"]);

/** Stable machine-readable code for an add-on denial — clients branch on this, never on the text. */
export const ADDON_GATE_CODE = "ADDON_GATE";

/**
 * Enforces @RequireAddon(key) through the gate registry (addon-gate-registry.ts). Guard order matters:
 * `@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)` — guards run BEFORE the TenantInterceptor, so the
 * tenant AsyncLocalStorage is NOT initialized here; read the tenantId from `req.user` (populated by
 * JwtAuthGuard), never from `prisma.getTenantId()`.
 */
@Injectable()
export class AddonGuard implements CanActivate {
  // Property-initialised on purpose: the constructor signature is part of the spec harness.
  private readonly logger = new Logger(AddonGuard.name);

  /** Last deny-warn timestamp per `tenant|keys` — throttles the enforced-deny log. */
  private readonly denyLoggedAt = new Map<string, number>();
  private static readonly DENY_LOG_WINDOW_MS = 60_000;

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

    const request = context.switchToHttp().getRequest<{
      user?: { tenantId?: string | null };
      method?: string;
      originalUrl?: string;
      url?: string;
    }>();
    const tenantId = request.user?.tenantId ?? null;
    // SUPER_ADMIN operates without a tenant — never addon-gated
    if (tenantId == null) return true;

    const active = await this.addonService.getActiveAddons(tenantId); // one query for any-of
    if (keys.some((k) => active.includes(k))) return true;

    // Observe-first, registry-driven: a key set whose EVERY key is registered `dark` is not enforced yet —
    // allow, and log the would-deny so the blast radius is readable before the flip. Any enforced (or
    // unregistered) key in the set keeps today's deny.
    const route = `${request.method ?? "?"} ${request.originalUrl ?? request.url ?? "?"}`;
    if (keys.every((k) => addonGateState(k) === "dark")) {
      this.logger.warn(
        `addon gate would deny (dark): keys=${keys.join(",")} tenant=${tenantId} route=${route}`,
      );
      return true;
    }

    // Name only the purchasable keys; internal flags stay out of tenant-facing text.
    const named = keys.filter((k) => !INTERNAL_ADDON_KEYS.has(k));
    const quoted = named.map((k) => `"${k}"`).join(", ");
    const message =
      named.length === 0
        ? "This feature is not enabled for your account."
        : named.length === 1
          ? `This feature requires the ${quoted} add-on.`
          : `This feature requires one of these add-ons: ${quoted}.`;
    // An enforced denial must leave a server-side trace: nothing downstream logs a handled 403
    // (SentryExceptionFilter captures >= 500 only, and there is no access-log middleware), so a
    // gate flip that starts denying live tenants would otherwise be invisible until a client calls.
    this.logDeny(keys, tenantId, route);
    throw new ForbiddenException({
      statusCode: 403,
      error: "Forbidden",
      code: ADDON_GATE_CODE,
      addonKeys: named,
      message,
    });
  }

  /**
   * One warn per tenant + key-set per minute. Class-level gates (routes, drivers, trips) sit on
   * endpoints a mobile client polls, so an ungranted tenant would otherwise emit a line per poll.
   */
  private logDeny(keys: string[], tenantId: string, route: string): void {
    const key = `${tenantId}|${keys.join(",")}`;
    const now = Date.now();
    const last = this.denyLoggedAt.get(key);
    if (last !== undefined && now - last < AddonGuard.DENY_LOG_WINDOW_MS) return;
    if (this.denyLoggedAt.size > 5000) this.denyLoggedAt.clear();
    this.denyLoggedAt.set(key, now);
    this.logger.warn(`addon gate denied: keys=${keys.join(",")} tenant=${tenantId} route=${route}`);
  }
}
