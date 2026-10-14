import { BadRequestException, Injectable } from "@nestjs/common";
import type { RestrictionsSettingsDto } from "@routeflow/types";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import {
  SYSTEM_CONFIG_GOVERNING_ADDRESS,
  SellingRestrictionsService,
} from "../selling-restrictions/selling-restrictions.service";
import { UpdateRestrictionsSettingsDto } from "./update-restrictions-settings.dto";

/**
 * Tenant governing-address policy for selling restrictions (Lane R step 6a). The value it WRITES is exactly the one
 * the engine's `getPolicy` reads (its own constant, never re-spelled).
 *
 * Row 510: the on/off switch and the readiness sweep are gone. Staff sales are always judged (a staff member with a
 * reason may override a warning), so there is nothing to switch and nothing to check before switching. A stored
 * `selling_restrictions.enabled` row is ignored; the settings endpoint neither returns nor accepts `enabled`.
 */
@Injectable()
export class RestrictionsSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SellingRestrictionsService,
    private readonly audit: AuditService,
  ) {}

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  async get(): Promise<RestrictionsSettingsDto> {
    const policy = await this.engine.getPolicy(this.requireTenant());
    return { governingAddress: policy.addressPrecedence };
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
    if (!precedenceChanges) return { governingAddress: before.addressPrecedence };

    await this.prisma.tenantTransaction(async (tx) => {
      await this.setConfig(
        tx,
        tenantId,
        SYSTEM_CONFIG_GOVERNING_ADDRESS,
        dto.governingAddress as string,
      );
    });

    const after = await this.engine.getPolicy(tenantId);
    await this.audit.log({
      tenantId,
      userId: user.sub,
      action: "selling_restrictions.settings_changed",
      entityType: "SystemConfig",
      entityId: tenantId,
      meta: {
        from: { governingAddress: before.addressPrecedence },
        to: { governingAddress: after.addressPrecedence },
      },
    });
    return { governingAddress: after.addressPrecedence };
  }
}
