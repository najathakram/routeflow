import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../email/email.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreateAuthorizationDto } from "./dto/create-authorization.dto";
import { RejectAuthorizationDto } from "./dto/reject-authorization.dto";
import { RenewAuthorizationDto } from "./dto/renew-authorization.dto";
import { SubmitAuthorizationDto } from "./dto/submit-authorization.dto";

export interface BuyerAuthorizationRow {
  trackedCategoryId: string;
  categoryName: string;
  status: "NONE" | "PENDING_REVIEW" | "VERIFIED" | "EXPIRED" | "REJECTED";
  source: "RETAILER_SUBMITTED" | "WHOLESALER_ADDED" | null;
  licenseNumber: string | null;
  expiresAt: Date | null;
  documentKey: string | null;
  submittedAt: Date | null;
  verifiedAt: Date | null;
}

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
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  async findForCustomer(customerId: string) {
    return this.prisma.forTenant().customerAuthorization.findMany({
      where: { customerId },
      include: { trackedCategory: { select: { id: true, name: true, requiresLicense: true } } },
      orderBy: [{ createdAt: "desc" }],
    });
  }

  /**
   * Buyer-facing list (W6b): every `requiresLicense` category for this seller,
   * left-joined with the buyer's authorization row so the buyer sees each
   * category with its current status (NONE when they've never submitted). Expiry
   * is evaluated lazily (VERIFIED past `expiresAt` reads as EXPIRED) so the list
   * agrees with the sale guard even before the W7 cron flips the persisted status.
   */
  async listForBuyer(customerId: string, now = new Date()): Promise<BuyerAuthorizationRow[]> {
    const categories = await this.prisma.forTenant().trackedCategory.findMany({
      where: { requiresLicense: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (categories.length === 0) return [];

    const auths = await this.prisma.forTenant().customerAuthorization.findMany({
      where: { customerId, trackedCategoryId: { in: categories.map((c) => c.id) } },
    });
    const byId = new Map(auths.map((a) => [a.trackedCategoryId, a]));

    return categories.map((c) => {
      const a = byId.get(c.id);
      const expired = !!(a?.status === "VERIFIED" && a.expiresAt && new Date(a.expiresAt) < now);
      return {
        trackedCategoryId: c.id,
        categoryName: c.name,
        status: a ? (expired ? "EXPIRED" : a.status) : "NONE",
        source: a?.source ?? null,
        licenseNumber: a?.licenseNumber ?? null,
        expiresAt: a?.expiresAt ?? null,
        documentKey: a?.documentKey ?? null,
        submittedAt: a?.createdAt ?? null,
        verifiedAt: a?.verifiedAt ?? null,
      };
    });
  }

  /**
   * Retailer-submitted (W6b): the buyer self-serve path → PENDING_REVIEW.
   * Upserts on unique(customer, category) but NEVER stamps a verifier (a buyer is
   * not a verifier) and NEVER clobbers a live VERIFIED authorization. Notifies the
   * seller's operators so they can approve/reject. Runs inside the buyer request's
   * tenant context (BuyerTenantInterceptor), so `forTenant()`/`getTenantId()` are
   * scoped to the active seller.
   */
  async submit(customerId: string, dto: SubmitAuthorizationDto) {
    await this.assertCustomer(customerId);
    const category = await this.assertLicenseCategory(dto.trackedCategoryId);

    const now = new Date();
    const existing = await this.prisma.forTenant().customerAuthorization.findUnique({
      where: {
        customerId_trackedCategoryId: { customerId, trackedCategoryId: dto.trackedCategoryId },
      },
    });
    // A buyer must not knock a currently-valid license back into review.
    this.assertNotLiveVerified(existing, now);

    const submitted = {
      status: "PENDING_REVIEW" as const,
      source: "RETAILER_SUBMITTED" as const,
      licenseNumber: dto.licenseNumber,
      expiresAt: new Date(dto.expiresAt),
      documentKey: dto.documentKey ?? null,
      // Clear any stale verifier snapshot from a prior (now expired/rejected) cycle —
      // a PENDING row is unverified by definition.
      verifiedById: null,
      verifiedByName: null,
      verifiedAt: null,
      // Re-arm expiry notifications: a fresh submission supersedes prior state.
      expiryNotifiedAt: null,
      expiringSoonNotifiedBucket: null,
    };

    let auth;
    try {
      auth = existing
        ? await this.prisma
            .forTenant()
            .customerAuthorization.update({ where: { id: existing.id }, data: submitted })
        : await (this.prisma.forTenant().customerAuthorization.create as any)({
            data: { customerId, trackedCategoryId: dto.trackedCategoryId, ...submitted },
          });
    } catch (err: any) {
      // Same composite-unique race guard as create().
      if (err?.code !== "P2002") throw err;
      const raced = await this.prisma.forTenant().customerAuthorization.findUnique({
        where: {
          customerId_trackedCategoryId: { customerId, trackedCategoryId: dto.trackedCategoryId },
        },
      });
      if (!raced) throw err;
      // The row we raced may be a VERIFIED license a concurrent operator create()
      // just wrote — re-apply the guard so we never demote it (and lose its
      // verifier snapshot) via the catch path.
      this.assertNotLiveVerified(raced, now);
      auth = await this.prisma
        .forTenant()
        .customerAuthorization.update({ where: { id: raced.id }, data: submitted });
    }

    await this.audit.log({
      tenantId: this.prisma.getTenantId(),
      userId: null,
      action: "regulated_authorization.submitted",
      entityType: "CustomerAuthorization",
      entityId: auth.id,
      meta: {
        customerId,
        trackedCategoryId: dto.trackedCategoryId,
        source: "RETAILER_SUBMITTED",
        shareConsent: dto.shareConsent,
      },
    });

    // Best-effort — a notification failure must not fail the submission.
    await this.notifyOperatorsOfSubmission(customerId, category.name).catch(() => {});
    return auth;
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

  /** Refuse to demote a still-valid VERIFIED license back into review. Applied both
   *  before the upsert AND in the P2002 catch (the raced row may be a VERIFIED
   *  license a concurrent operator create() just wrote). */
  private assertNotLiveVerified(
    row: { status: string; expiresAt: Date | null } | null,
    now: Date,
  ): void {
    if (row && row.status === "VERIFIED" && (!row.expiresAt || new Date(row.expiresAt) > now)) {
      throw new BadRequestException(
        "This license is already verified with this seller — it doesn't need to be resubmitted.",
      );
    }
  }

  /** Buyer submissions are only meaningful for license-gated categories. Returns
   *  the category (tenant-scoped, so a cross-tenant id 404s). */
  private async assertLicenseCategory(trackedCategoryId: string) {
    const cat = await this.prisma.forTenant().trackedCategory.findUnique({
      where: { id: trackedCategoryId },
      select: { id: true, name: true, requiresLicense: true },
    });
    if (!cat) throw new NotFoundException("Tracked category not found");
    if (!cat.requiresLicense)
      throw new BadRequestException("This category does not require a license.");
    return cat;
  }

  /** Notify the seller's operators (push + email) that a buyer submitted a license
   *  for review. Mirrors AuthorizationExpiryService.notify; best-effort per recipient. */
  private async notifyOperatorsOfSubmission(
    customerId: string,
    categoryName: string,
  ): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { businessName: true } });
    const who = customer?.businessName ?? "A customer";
    const operators = await this.prisma.user.findMany({
      where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] }, status: "ACTIVE" },
      select: { id: true, email: true },
    });
    const subject = `License submitted for review: ${categoryName}`;
    const body = `${who} submitted a ${categoryName} license for review. Approve or reject it on their customer record.`;
    for (const op of operators) {
      await this.notifications.sendToUser(op.id, { title: subject, body }).catch(() => {});
      if (op.email && !op.email.startsWith("no-email+")) {
        await this.email
          .send({ to: op.email, subject: `${who} — ${subject}`, html: `<p>${body}</p>` })
          .catch(() => {});
      }
    }
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
