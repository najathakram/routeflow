import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreateAuthorizationDto } from "./dto/create-authorization.dto";
import { RejectAuthorizationDto } from "./dto/reject-authorization.dto";
import { RenewAuthorizationDto } from "./dto/renew-authorization.dto";

/** A license authorization that is expiring soon (30/7/1) or already expired — W7b bell. */
export interface ExpiringAuthorization {
  id: string;
  customerId: string;
  customerName: string;
  trackedCategoryId: string;
  categoryName: string;
  status: "VERIFIED" | "EXPIRED";
  expiresAt: Date | null;
  /** 30 | 7 | 1 for an expiring-soon VERIFIED row; null once expired. */
  bucket: 30 | 7 | 1 | null;
  expired: boolean;
}

const DAY_MS = 86_400_000;

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

  /**
   * W7b expiry bell (operator): every license-required authorization in the tenant
   * that is already EXPIRED or VERIFIED-and-expiring within `withinDays`. Mirrors
   * the sweep's gating (requiresLicense only — tobacco is never surfaced).
   */
  async findExpiringSoon(withinDays = 30, now = new Date()): Promise<ExpiringAuthorization[]> {
    // This is a tenant-wide list. A SUPER_ADMIN carries no tenant context, so
    // forTenant() would run UNSCOPED across all tenants — return nothing instead
    // of leaking every tenant's licenses (the bell is a per-tenant operator tool).
    if (!this.prisma.getTenantId()) return [];
    return this.mapExpiring(await this.queryExpiring(withinDays, now), now);
  }

  /** W7b expiry bell (buyer): the caller's own expiring/expired licenses at this seller. */
  async findExpiringForCustomer(
    customerId: string,
    withinDays = 30,
    now = new Date(),
  ): Promise<ExpiringAuthorization[]> {
    return this.mapExpiring(await this.queryExpiring(withinDays, now, customerId), now);
  }

  private async queryExpiring(withinDays: number, now: Date, customerId?: string) {
    const horizon = new Date(now.getTime() + withinDays * DAY_MS);
    return this.prisma.forTenant().customerAuthorization.findMany({
      where: {
        ...(customerId ? { customerId } : {}),
        trackedCategory: { requiresLicense: true },
        OR: [{ status: "EXPIRED" }, { status: "VERIFIED", expiresAt: { not: null, lte: horizon } }],
      },
      include: {
        customer: { select: { businessName: true } },
        trackedCategory: { select: { name: true } },
      },
      orderBy: [{ expiresAt: "asc" }],
    });
  }

  private mapExpiring(
    rows: Array<{
      id: string;
      customerId: string;
      trackedCategoryId: string;
      status: string;
      expiresAt: Date | null;
      customer: { businessName: string | null } | null;
      trackedCategory: { name: string } | null;
    }>,
    now: Date,
  ): ExpiringAuthorization[] {
    return rows.map((a) => {
      let expired = a.status === "EXPIRED";
      let bucket: 30 | 7 | 1 | null = null;
      if (!expired && a.expiresAt) {
        const ms = new Date(a.expiresAt).getTime() - now.getTime();
        if (ms <= 0) expired = true;
        else if (ms <= DAY_MS) bucket = 1;
        else if (ms <= 7 * DAY_MS) bucket = 7;
        else if (ms <= 30 * DAY_MS) bucket = 30;
      }
      return {
        id: a.id,
        customerId: a.customerId,
        customerName: a.customer?.businessName ?? "Customer",
        trackedCategoryId: a.trackedCategoryId,
        categoryName: a.trackedCategory?.name ?? "",
        status: expired ? "EXPIRED" : "VERIFIED",
        expiresAt: a.expiresAt,
        bucket,
        expired,
      };
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
        // Re-arm expiry notifications ONLY when the expiry window actually moves —
        // else a renew that only touches the license number would re-warn the same
        // 30/7/1 bucket on the next sweep.
        ...(dto.expiresAt !== undefined
          ? {
              expiresAt: new Date(dto.expiresAt),
              expiryNotifiedAt: null,
              expiringSoonNotifiedBucket: null,
            }
          : {}),
        ...(dto.documentKey !== undefined ? { documentKey: dto.documentKey } : {}),
        verifiedById: user.sub,
        verifiedByName: user.username,
        verifiedAt: new Date(),
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
