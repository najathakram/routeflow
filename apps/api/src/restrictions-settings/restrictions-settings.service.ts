import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { RestrictionsEnableReadiness, RestrictionsSettingsDto } from "@routeflow/types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import {
  SELLING_RESTRICTIONS_DISABLED_VALUE,
  SELLING_RESTRICTIONS_ENABLED_VALUE,
  SYSTEM_CONFIG_ENABLED,
  SYSTEM_CONFIG_GOVERNING_ADDRESS,
  SellingRestrictionsService,
} from "../selling-restrictions/selling-restrictions.service";
import { UpdateRestrictionsSettingsDto } from "./update-restrictions-settings.dto";

/** DI token for the per-tenant limiter storage (the repo's `RedisThrottlerStorage`, same INCR window). */
export const READINESS_LIMITER = Symbol("RESTRICTIONS_READINESS_LIMITER");

/**
 * The readiness sweep reads every customer, so it is limited PER TENANT (not per IP — the global
 * guard runs before authentication and cannot see a verified tenant): at most `limit` sweeps per
 * `ttl` ms for one tenant, however many admins or IPs ask.
 */
export const READINESS_THROTTLE = { ttl: 60_000, limit: 5 } as const;

/**
 * Tenant switch + governing-address policy for selling restrictions (Lane R step 6a). The values it
 * WRITES are exactly the ones the engine's `getPolicy` reads (its own constants, never re-spelled),
 * and turning the feature ON goes through the engine's `assertReadyToEnable`: an un-backfilled
 * tenant is refused with a 409 that says what to fix, instead of silently making orders INDETERMINATE.
 * Writes are ONE transaction: both keys land or neither does.
 */
@Injectable()
export class RestrictionsSettingsService {
  private readonly logger = new Logger(RestrictionsSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SellingRestrictionsService,
    private readonly audit: AuditService,
    @Inject(READINESS_LIMITER) private readonly limiter: Pick<ThrottlerStorage, "increment">,
  ) {}

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  async get(): Promise<RestrictionsSettingsDto> {
    const policy = await this.engine.getPolicy(this.requireTenant());
    return { enabled: policy.enabled, governingAddress: policy.addressPrecedence };
  }

  /** The customer sweep, admin-only at the route and throttled per tenant here (429 past the limit). */
  async readiness(): Promise<RestrictionsEnableReadiness> {
    const tenantId = this.requireTenant();
    await this.throttleReadiness(tenantId);
    return this.engine.getEnableReadiness(tenantId);
  }

  private async throttleReadiness(tenantId: string): Promise<void> {
    const { ttl, limit } = READINESS_THROTTLE;
    let hit: { totalHits: number; timeToExpire: number } | null = null;
    try {
      hit = await this.limiter.increment(
        `restrictions-readiness:${tenantId}`,
        ttl,
        limit,
        0,
        "restrictions-readiness",
      );
    } catch (e) {
      // An unreachable limiter must not take an admin diagnostic down with it (it is abuse
      // protection, not an authorisation gate) — fail open, loudly.
      this.logger.warn(
        `readiness limiter unavailable, allowing the request: ${(e as Error).message}`,
      );
    }
    if (hit && hit.totalHits > limit) {
      throw new HttpException(
        {
          message: "Too many readiness checks. Try again shortly.",
          retryAfterSeconds: Math.ceil(hit.timeToExpire),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** findFirst + create/update inside the caller's tx (the tenant proxy can't inject the composite unique into an upsert). */
  private async setConfig(
    tx: Prisma.TransactionClient,
    tenantId: string,
    key: string,
    value: string,
  ) {
    const existing = await tx.systemConfig.findFirst({
      where: { tenantId, key },
      select: { id: true },
    });
    if (existing) await tx.systemConfig.update({ where: { id: existing.id }, data: { value } });
    else await tx.systemConfig.create({ data: { tenantId, key, value } });
  }

  async update(
    dto: UpdateRestrictionsSettingsDto,
    user: JwtPayload,
  ): Promise<RestrictionsSettingsDto> {
    const tenantId = this.requireTenant();
    const before = await this.engine.getPolicy(tenantId);
    const precedenceChanges =
      dto.governingAddress !== undefined && dto.governingAddress !== before.addressPrecedence;
    const enabling = dto.enabled === true && !before.enabled;

    // Readiness is judged under the address policy ALREADY in force; judging it under one that is being
    // changed in the same request would need that policy applied first. Two steps keep it honest.
    if (enabling && precedenceChanges) {
      throw new BadRequestException(
        "Change which address decides the state first, then turn enforcement on, so readiness is checked under the policy that will apply.",
      );
    }
    if (enabling) await this.engine.assertReadyToEnable(tenantId);

    const writes: Array<[string, string]> = [];
    if (precedenceChanges)
      writes.push([SYSTEM_CONFIG_GOVERNING_ADDRESS, dto.governingAddress as string]);
    if (dto.enabled !== undefined && dto.enabled !== before.enabled) {
      writes.push([
        SYSTEM_CONFIG_ENABLED,
        dto.enabled ? SELLING_RESTRICTIONS_ENABLED_VALUE : SELLING_RESTRICTIONS_DISABLED_VALUE,
      ]);
    }
    if (writes.length === 0)
      return { enabled: before.enabled, governingAddress: before.addressPrecedence };

    // ONE transaction: a failure on any write rolls back all of them (no compensating write needed).
    await this.prisma.tenantTransaction(async (tx) => {
      for (const [key, value] of writes) await this.setConfig(tx, tenantId, key, value);
    });

    const after = await this.engine.getPolicy(tenantId);
    await this.audit.log({
      tenantId,
      userId: user.sub,
      action: "selling_restrictions.settings_changed",
      entityType: "SystemConfig",
      entityId: tenantId,
      meta: {
        from: { enabled: before.enabled, governingAddress: before.addressPrecedence },
        to: { enabled: after.enabled, governingAddress: after.addressPrecedence },
      },
    });
    return { enabled: after.enabled, governingAddress: after.addressPrecedence };
  }
}
