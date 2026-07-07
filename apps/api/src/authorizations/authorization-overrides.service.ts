import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreateOverrideDto } from "./dto/create-override.dto";
import { isScopeActive } from "./authorization-scope";

/**
 * Phase 4 (W6, spec §8): the "sold under my responsibility" override. An operator
 * selling a regulated item to a customer without a verified license records an
 * append-only AuthorizationOverride (immutable actor snapshot) which ALSO lands in
 * the AuditLog. The override satisfies the license guard for its scope only —
 * it never unlocks the buyer portal (that still requires VERIFIED).
 */
@Injectable()
export class AuthorizationOverridesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createOverride(customerId: string, dto: CreateOverrideDto, user: JwtPayload) {
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new NotFoundException("Customer not found");
    // The category must belong to this tenant (forTenant → null for a cross-tenant id).
    const cat = await this.prisma
      .forTenant()
      .trackedCategory.findUnique({ where: { id: dto.trackedCategoryId }, select: { id: true } });
    if (!cat) throw new NotFoundException("Tracked category not found");

    // forTenant() injects tenantId at runtime; the create type still requires it, so cast.
    const override = await (this.prisma.forTenant().authorizationOverride.create as any)({
      data: {
        customerId,
        trackedCategoryId: dto.trackedCategoryId,
        scope: dto.scope,
        reason: dto.reason,
        acknowledgedTenant: dto.acknowledgedTenant,
        // Immutable actor snapshot — the §8 record must survive the operator being deleted.
        acceptedById: user.sub,
        acceptedByName: user.username,
      },
    });

    // The responsibility record must ALSO be an immutable AuditLog entry, not rely
    // solely on the override row.
    await this.audit.log({
      tenantId: this.prisma.getTenantId(),
      userId: user.sub,
      action: "regulated.responsibility_override",
      entityType: "AuthorizationOverride",
      entityId: override.id,
      meta: {
        customerId,
        trackedCategoryId: dto.trackedCategoryId,
        scope: dto.scope,
        reason: dto.reason,
      },
    });

    return override;
  }

  /** Is there an active override covering this customer + category (+ order)? */
  async isOverrideActive(
    customerId: string,
    trackedCategoryId: string,
    orderId?: string,
  ): Promise<boolean> {
    const overrides = await this.prisma.forTenant().authorizationOverride.findMany({
      where: { customerId, trackedCategoryId },
      select: { scope: true },
    });
    const now = new Date();
    return overrides.some((o) => isScopeActive(o.scope, { orderId, now }));
  }
}
