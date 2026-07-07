import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreateAuthorizationDto } from "./dto/create-authorization.dto";
import { RejectAuthorizationDto } from "./dto/reject-authorization.dto";
import { RenewAuthorizationDto } from "./dto/renew-authorization.dto";

/**
 * Phase 4 (W6): the CustomerAuthorization lifecycle
 * (NONE → PENDING_REVIEW → VERIFIED → EXPIRED/REJECTED). Two paths to VERIFIED:
 * wholesaler-added (operator adds → VERIFIED immediately) and retailer-submitted
 * (buyer submits → PENDING_REVIEW → operator approves). All writes stamp the
 * immutable verifier snapshot and are tenant-scoped via prisma.forTenant().
 */
@Injectable()
export class AuthorizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findForCustomer(customerId: string) {
    return this.prisma.forTenant().customerAuthorization.findMany({
      where: { customerId },
      include: { trackedCategory: { select: { id: true, name: true, requiresLicense: true } } },
      orderBy: [{ createdAt: "desc" }],
    });
  }

  /** Wholesaler-added: VERIFIED immediately. Upserts on unique(customer, category). */
  async create(customerId: string, dto: CreateAuthorizationDto, user: JwtPayload) {
    await this.assertCustomer(customerId);
    await this.assertCategory(dto.trackedCategoryId);
    const verifiedSnapshot = {
      status: "VERIFIED" as const,
      source: "WHOLESALER_ADDED" as const,
      licenseNumber: dto.licenseNumber ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      documentKey: dto.documentKey ?? null,
      verifiedById: user.sub,
      verifiedByName: user.username,
      verifiedAt: new Date(),
      // W7: a fresh verification re-arms the expiry notifications.
      expiryNotifiedAt: null,
      expiringSoonNotifiedBucket: null,
    };
    // forTenant() can't inject tenantId into a composite-unique upsert — findFirst + create/update.
    const existing = await this.prisma.forTenant().customerAuthorization.findUnique({
      where: {
        customerId_trackedCategoryId: { customerId, trackedCategoryId: dto.trackedCategoryId },
      },
    });
    let auth;
    try {
      auth = existing
        ? await this.prisma
            .forTenant()
            .customerAuthorization.update({ where: { id: existing.id }, data: verifiedSnapshot })
        : await (this.prisma.forTenant().customerAuthorization.create as any)({
            data: { customerId, trackedCategoryId: dto.trackedCategoryId, ...verifiedSnapshot },
          });
    } catch (err: any) {
      // Concurrent add of the same (customer, category) races the composite unique;
      // resolve to the now-existing row instead of surfacing a raw 500.
      if (err?.code !== "P2002") throw err;
      const raced = await this.prisma.forTenant().customerAuthorization.findUnique({
        where: {
          customerId_trackedCategoryId: { customerId, trackedCategoryId: dto.trackedCategoryId },
        },
      });
      if (!raced) throw err;
      auth = await this.prisma
        .forTenant()
        .customerAuthorization.update({ where: { id: raced.id }, data: verifiedSnapshot });
    }
    await this.log(user, auth.id, "created", { customerId, source: "WHOLESALER_ADDED" });
    return auth;
  }

  async approve(customerId: string, authId: string, user: JwtPayload) {
    const auth = await this.getOwned(customerId, authId);
    if (auth.status !== "PENDING_REVIEW")
      throw new BadRequestException("Only pending authorizations can be approved");
    const updated = await this.prisma.forTenant().customerAuthorization.update({
      where: { id: authId },
      data: {
        status: "VERIFIED",
        verifiedById: user.sub,
        verifiedByName: user.username,
        verifiedAt: new Date(),
        expiryNotifiedAt: null,
        expiringSoonNotifiedBucket: null,
      },
    });
    await this.log(user, authId, "approved", { customerId });
    return updated;
  }

  async reject(customerId: string, authId: string, dto: RejectAuthorizationDto, user: JwtPayload) {
    const auth = await this.getOwned(customerId, authId);
    if (auth.status !== "PENDING_REVIEW")
      throw new BadRequestException("Only pending authorizations can be rejected");
    const updated = await this.prisma.forTenant().customerAuthorization.update({
      where: { id: authId },
      data: { status: "REJECTED" },
    });
    await this.log(user, authId, "rejected", { customerId, reason: dto.reason ?? null });
    return updated;
  }

  /** Re-verify with a fresh license/expiry (spec §8 "update one field + re-verify"). */
  async renew(customerId: string, authId: string, dto: RenewAuthorizationDto, user: JwtPayload) {
    const auth = await this.getOwned(customerId, authId);
    // Renew re-verifies — only from an already-vetted state. Blocks laundering a
    // REJECTED / PENDING_REVIEW / NONE row straight to VERIFIED (bypassing approve()).
    if (auth.status !== "VERIFIED" && auth.status !== "EXPIRED")
      throw new BadRequestException("Only verified or expired authorizations can be renewed");
    const updated = await this.prisma.forTenant().customerAuthorization.update({
      where: { id: authId },
      data: {
        status: "VERIFIED",
        ...(dto.licenseNumber !== undefined ? { licenseNumber: dto.licenseNumber } : {}),
        ...(dto.expiresAt !== undefined ? { expiresAt: new Date(dto.expiresAt) } : {}),
        ...(dto.documentKey !== undefined ? { documentKey: dto.documentKey } : {}),
        verifiedById: user.sub,
        verifiedByName: user.username,
        verifiedAt: new Date(),
        expiryNotifiedAt: null,
        expiringSoonNotifiedBucket: null,
      },
    });
    await this.log(user, authId, "renewed", { customerId, prevStatus: auth.status });
    return updated;
  }

  private async assertCustomer(customerId: string) {
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw new NotFoundException("Customer not found");
  }

  /** The category must belong to THIS tenant — forTenant() returns null for a
   *  cross-tenant id, so this blocks writing a row that FK-references another
   *  tenant's category. */
  private async assertCategory(trackedCategoryId: string) {
    const cat = await this.prisma
      .forTenant()
      .trackedCategory.findUnique({ where: { id: trackedCategoryId }, select: { id: true } });
    if (!cat) throw new NotFoundException("Tracked category not found");
  }

  private async getOwned(customerId: string, authId: string) {
    const auth = await this.prisma
      .forTenant()
      .customerAuthorization.findUnique({ where: { id: authId } });
    if (!auth || auth.customerId !== customerId)
      throw new NotFoundException("Authorization not found");
    return auth;
  }

  private async log(
    user: JwtPayload,
    entityId: string,
    action: string,
    meta: Record<string, unknown>,
  ) {
    await this.audit.log({
      tenantId: this.prisma.getTenantId(),
      userId: user.sub,
      action: `regulated_authorization.${action}`,
      entityType: "CustomerAuthorization",
      entityId,
      meta,
    });
  }
}
