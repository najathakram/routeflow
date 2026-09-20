import { BadRequestException, Injectable } from "@nestjs/common";
import type {
  RestrictionsEnableReadiness,
  RestrictionsSettingsDto,
  RestrictionsSettingsWithReadinessDto,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { SystemConfigService } from "../system-config/system-config.service";
import {
  SELLING_RESTRICTIONS_DISABLED_VALUE,
  SELLING_RESTRICTIONS_ENABLED_VALUE,
  SYSTEM_CONFIG_ENABLED,
  SYSTEM_CONFIG_GOVERNING_ADDRESS,
  SellingRestrictionsService,
} from "../selling-restrictions/selling-restrictions.service";
import { UpdateRestrictionsSettingsDto } from "./update-restrictions-settings.dto";

/**
 * Tenant switch + governing-address policy for selling restrictions (Lane R step 6a). The values it
 * WRITES are exactly the ones the engine's `getPolicy` reads (its own constants, never re-spelled),
 * and turning the feature ON goes through the engine's `assertReadyToEnable`: an un-backfilled
 * tenant is refused with a 409 that says what to fix, instead of silently making orders INDETERMINATE.
 */
@Injectable()
export class RestrictionsSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: SystemConfigService,
    private readonly engine: SellingRestrictionsService,
    private readonly audit: AuditService,
  ) {}

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  async get(withReadiness = false): Promise<RestrictionsSettingsWithReadinessDto> {
    const tenantId = this.requireTenant();
    const policy = await this.engine.getPolicy(tenantId);
    // Same structural type, so a field added to the engine's probe fails to compile here until the wire type follows.
    const readiness: RestrictionsEnableReadiness | null = withReadiness
      ? await this.engine.getEnableReadiness(tenantId)
      : null;
    return { enabled: policy.enabled, governingAddress: policy.addressPrecedence, readiness };
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

    if (precedenceChanges) {
      await this.config.set(SYSTEM_CONFIG_GOVERNING_ADDRESS, dto.governingAddress as string);
    }
    if (enabling) {
      try {
        // Under the precedence being applied: it decides which address governs, hence what is ready.
        await this.engine.assertReadyToEnable(tenantId);
      } catch (e) {
        if (precedenceChanges) {
          await this.config.set(SYSTEM_CONFIG_GOVERNING_ADDRESS, before.addressPrecedence);
        }
        throw e;
      }
    }
    if (dto.enabled !== undefined && dto.enabled !== before.enabled) {
      await this.config.set(
        SYSTEM_CONFIG_ENABLED,
        dto.enabled ? SELLING_RESTRICTIONS_ENABLED_VALUE : SELLING_RESTRICTIONS_DISABLED_VALUE,
      );
    }
    const after = await this.engine.getPolicy(tenantId);
    if (after.enabled !== before.enabled || after.addressPrecedence !== before.addressPrecedence) {
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
    }
    return { enabled: after.enabled, governingAddress: after.addressPrecedence };
  }
}
