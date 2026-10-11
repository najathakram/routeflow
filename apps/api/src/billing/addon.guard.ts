import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { REQUIRE_ADDON_KEY } from "./require-addon.decorator";
import { addonGateState } from "./addon-gate-registry";
import { decideAddonAccess } from "./addon-access";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { redactedRoute } from "../common/redacted-route";

/**
 * Addon keys that are internal platform-admin switches rather than purchasable add-ons.
 * They are honoured as any-of keys but NEVER named in the 403 message — the web toasts
 * that message verbatim (MutationCache.onError), so echoing them would leak a hidden flag
 * and give tenants upgrade guidance they cannot act on. String literals on purpose: API
 * source never imports @routeflow/types at runtime.
 */
const INTERNAL_ADDON_KEYS = new Set(["developer_mode"]);

/** Stable machine-readable code for an add-on denial — clients branch on this, never on the text. */
export const ADDON_GATE_CODE = API_ERROR_CODES.ADDON_GATE;

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
    private readonly entitlements: EntitlementsService,
    private readonly featureOverrides: FeatureOverrideService,
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
      route?: { path?: unknown } | null;
      originalUrl?: string;
      url?: string;
    }>();
    const tenantId = request.user?.tenantId ?? null;
    // SUPER_ADMIN operates without a tenant — never addon-gated
    if (tenantId == null) return true;

    // The one shared decision (addon-access.ts, also used by the mailbox send path): an active
    // override is absolute, then a held add-on, then the dark courtesy allow (registry-driven,
    // never for an always-enforced tenant), else deny.
    // Route template (token-redacted path when none matched), never the raw URL.
    const route = redactedRoute(request);
    const { outcome, overrides } = await decideAddonAccess(
      {
        addonService: this.addonService,
        entitlements: this.entitlements,
        featureOverrides: this.featureOverrides,
      },
      tenantId,
      keys,
    );
    if (outcome === "granted") return true;
    // Observe-first: a dark key set is not enforced yet — allow, and log the would-deny so the
    // blast radius is readable before the flip.
    if (outcome === "dark") {
      this.logger.warn(
        `addon gate would deny (dark): keys=${keys.join(",")} tenant=${tenantId} route=${route}`,
      );
      return true;
    }

    // A DENY override firing while its own gate is dark needs its own would-deny-style trace
    // line for the blast report, even though the final decision here is a hard deny
    // (dark-gate semantics never soften an explicit DENY — owner ruling).
    const deniedDarkKeys = keys.filter(
      (k) => overrides.get(k) === "DENY" && addonGateState(k) === "dark",
    );
    if (deniedDarkKeys.length > 0) {
      this.logger.warn(
        `addon gate override-denied on a dark key: keys=${deniedDarkKeys.join(",")} tenant=${tenantId} route=${route}`,
      );
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
