import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { BuyerMergeRequestStatus, MergeInitiator } from "@prisma/client";

@Injectable()
export class BuyerMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  // ─── Buyer: initiate merge ────────────────────────────────────────────────────

  async initiateMerge(primaryBuyerId: string, secondaryEmail: string, notes?: string) {
    const primary = await this.prisma.buyerAccount.findUnique({ where: { id: primaryBuyerId } });
    if (!primary || primary.status === "DELETED") throw new NotFoundException("Primary account not found");

    const secondary = await this.prisma.buyerAccount.findFirst({
      where: { email: secondaryEmail, status: { not: "DELETED" } },
    });
    if (!secondary) throw new NotFoundException("No active account found with that email address");
    if (secondary.id === primaryBuyerId) throw new BadRequestException("Cannot merge an account with itself");

    // Check for existing open merge request between these two accounts
    const existing = await this.prisma.buyerMergeRequest.findFirst({
      where: {
        primaryAccountId: primaryBuyerId,
        secondaryAccountId: secondary.id,
        status: { in: [BuyerMergeRequestStatus.PENDING_VERIFICATION, BuyerMergeRequestStatus.PENDING_REVIEW] },
      },
    });
    if (existing) throw new ConflictException("An open merge request between these accounts already exists");

    // Check secondary isn't already a target of another pending merge
    const secondaryAsTarget = await this.prisma.buyerMergeRequest.findFirst({
      where: {
        secondaryAccountId: secondary.id,
        status: { in: [BuyerMergeRequestStatus.PENDING_VERIFICATION, BuyerMergeRequestStatus.PENDING_REVIEW] },
      },
    });
    if (secondaryAsTarget) throw new ConflictException("This account is already pending another merge request");

    // Generate a one-time verification token
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const mergeRequest = await this.prisma.buyerMergeRequest.create({
      data: {
        primaryAccountId: primaryBuyerId,
        secondaryAccountId: secondary.id,
        status: BuyerMergeRequestStatus.PENDING_VERIFICATION,
        initiatedBy: MergeInitiator.BUYER,
        initiatorNotes: notes,
        verificationToken: token,
        verificationExpires: expires,
      },
    });

    const appUrl = process.env.WEB_APP_URL ?? process.env.NEXTAUTH_URL ?? "http://localhost:3001";
    const verifyUrl = `${appUrl}/buyer/verify-merge?token=${token}`;

    await this.emailService.sendMergeVerificationEmail({
      to: secondary.email,
      primaryEmail: primary.email,
      verifyUrl,
    });

    return {
      id: mergeRequest.id,
      status: mergeRequest.status,
      message: `A verification email has been sent to ${secondaryEmail}. Once confirmed, a platform admin will review and complete the merge.`,
    };
  }

  // ─── Buyer: verify merge token ────────────────────────────────────────────────

  async verifyMergeToken(token: string) {
    const mergeRequest = await this.prisma.buyerMergeRequest.findUnique({
      where: { verificationToken: token },
    });

    if (!mergeRequest) throw new NotFoundException("Invalid verification token");
    if (mergeRequest.status !== BuyerMergeRequestStatus.PENDING_VERIFICATION) {
      throw new BadRequestException("This merge request has already been processed");
    }
    if (mergeRequest.verificationExpires && mergeRequest.verificationExpires < new Date()) {
      throw new GoneException("Verification token has expired. Please initiate a new merge request.");
    }

    await this.prisma.buyerMergeRequest.update({
      where: { id: mergeRequest.id },
      data: {
        status: BuyerMergeRequestStatus.PENDING_REVIEW,
        verifiedAt: new Date(),
        verificationToken: null,
        verificationExpires: null,
      },
    });

    return { success: true, message: "Your account ownership is confirmed. A platform admin will review and complete the merge shortly." };
  }

  // ─── Tenant: suggest merge ────────────────────────────────────────────────────

  async suggestMerge(tenantId: string, primaryCustomerId: string, secondaryCustomerId: string, notes?: string) {
    if (primaryCustomerId === secondaryCustomerId) throw new BadRequestException("Cannot merge a customer with itself");

    // Resolve customer links to buyer accounts
    const [primaryLink, secondaryLink] = await Promise.all([
      this.prisma.customerLink.findFirst({
        where: { customerId: primaryCustomerId, tenantId },
        include: { customer: { select: { businessName: true } } },
      }),
      this.prisma.customerLink.findFirst({
        where: { customerId: secondaryCustomerId, tenantId },
        include: { customer: { select: { businessName: true } } },
      }),
    ]);

    if (!primaryLink?.buyerAccountId) {
      const c = primaryLink?.customer;
      throw new UnprocessableEntityException(
        `Customer "${c?.businessName ?? primaryCustomerId}" is not connected to a buyer portal account`,
      );
    }
    if (!secondaryLink?.buyerAccountId) {
      const c = secondaryLink?.customer;
      throw new UnprocessableEntityException(
        `Customer "${c?.businessName ?? secondaryCustomerId}" is not connected to a buyer portal account`,
      );
    }

    if (primaryLink.buyerAccountId === secondaryLink.buyerAccountId) {
      throw new ConflictException("Both customers are already linked to the same buyer account");
    }

    // Check for existing open merge request
    const existing = await this.prisma.buyerMergeRequest.findFirst({
      where: {
        primaryAccountId: primaryLink.buyerAccountId,
        secondaryAccountId: secondaryLink.buyerAccountId,
        status: { in: [BuyerMergeRequestStatus.PENDING_VERIFICATION, BuyerMergeRequestStatus.PENDING_REVIEW] },
      },
    });
    if (existing) throw new ConflictException("An open merge request between these accounts already exists");

    const mergeRequest = await this.prisma.buyerMergeRequest.create({
      data: {
        primaryAccountId: primaryLink.buyerAccountId,
        secondaryAccountId: secondaryLink.buyerAccountId,
        status: BuyerMergeRequestStatus.PENDING_REVIEW,
        initiatedBy: MergeInitiator.TENANT,
        initiatedByTenantId: tenantId,
        initiatorNotes: notes,
      },
    });

    return { id: mergeRequest.id, status: mergeRequest.status, message: "Merge suggestion submitted for admin review." };
  }

  // ─── Admin: create merge request directly ─────────────────────────────────────

  async createAdminMergeRequest(primaryId: string, secondaryId: string, adminNotes?: string) {
    if (primaryId === secondaryId) throw new BadRequestException("Cannot merge an account with itself");

    const [primary, secondary] = await Promise.all([
      this.prisma.buyerAccount.findUnique({ where: { id: primaryId } }),
      this.prisma.buyerAccount.findUnique({ where: { id: secondaryId } }),
    ]);
    if (!primary || primary.status === "DELETED") throw new NotFoundException("Primary account not found");
    if (!secondary || secondary.status === "DELETED") throw new NotFoundException("Secondary account not found");

    const existing = await this.prisma.buyerMergeRequest.findFirst({
      where: {
        primaryAccountId: primaryId,
        secondaryAccountId: secondaryId,
        status: { in: [BuyerMergeRequestStatus.PENDING_VERIFICATION, BuyerMergeRequestStatus.PENDING_REVIEW] },
      },
    });
    if (existing) throw new ConflictException("An open merge request between these accounts already exists");

    const mergeRequest = await this.prisma.buyerMergeRequest.create({
      data: {
        primaryAccountId: primaryId,
        secondaryAccountId: secondaryId,
        status: BuyerMergeRequestStatus.PENDING_REVIEW,
        initiatedBy: MergeInitiator.SUPER_ADMIN,
        adminNotes,
      },
    });

    return mergeRequest;
  }

  // ─── Admin: list merge requests ───────────────────────────────────────────────

  async listMergeRequests(query: { page?: number; limit?: number; status?: string }) {
    const page = Number(query.page ?? 1);
    const limit = Math.min(Number(query.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;

    const [data, total] = await Promise.all([
      this.prisma.buyerMergeRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          primaryAccount: { select: { id: true, email: true, name: true } },
          secondaryAccount: { select: { id: true, email: true, name: true } },
          initiatingTenant: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.buyerMergeRequest.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── Admin: get merge request preview ────────────────────────────────────────

  async getMergeRequestPreview(mergeRequestId: string) {
    const req = await this.prisma.buyerMergeRequest.findUnique({
      where: { id: mergeRequestId },
      include: {
        primaryAccount: {
          include: {
            customerLinks: {
              include: { tenant: { select: { id: true, name: true, slug: true } }, customer: { select: { id: true, businessName: true } } },
            },
          },
        },
        secondaryAccount: {
          include: {
            customerLinks: {
              include: { tenant: { select: { id: true, name: true, slug: true } }, customer: { select: { id: true, businessName: true } } },
            },
          },
        },
        initiatingTenant: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!req) throw new NotFoundException("Merge request not found");

    const primaryTenantIds = new Set(req.primaryAccount.customerLinks.map((l) => l.tenantId));

    const linksToTransfer = req.secondaryAccount.customerLinks.filter((l) => !primaryTenantIds.has(l.tenantId));
    const conflictingLinks = req.secondaryAccount.customerLinks.filter((l) => primaryTenantIds.has(l.tenantId));

    const googleIdTransfer =
      !req.primaryAccount.googleId && !!req.secondaryAccount.googleId;
    const googleIdConflict =
      !!req.primaryAccount.googleId && !!req.secondaryAccount.googleId;

    return {
      ...req,
      preview: {
        linksToTransfer,
        conflictingLinks,
        googleIdTransfer,
        googleIdConflict,
      },
    };
  }

  // ─── Admin: execute merge ─────────────────────────────────────────────────────

  async executeMerge(mergeRequestId: string) {
    const req = await this.prisma.buyerMergeRequest.findUnique({
      where: { id: mergeRequestId },
      include: {
        primaryAccount: true,
        secondaryAccount: true,
      },
    });

    if (!req) throw new NotFoundException("Merge request not found");
    if (req.status !== BuyerMergeRequestStatus.PENDING_REVIEW) {
      throw new BadRequestException("Only PENDING_REVIEW merge requests can be executed");
    }

    const { primaryAccount, secondaryAccount } = req;

    if (primaryAccount.status === "DELETED") throw new BadRequestException("Primary account is deleted");
    if (secondaryAccount.status === "DELETED") throw new BadRequestException("Secondary account is already deleted/merged");

    // Get secondary's customer links
    const secondaryLinks = await this.prisma.customerLink.findMany({
      where: { buyerAccountId: secondaryAccount.id },
    });

    // Determine which secondary links conflict (primary already has a link for same tenantId)
    const primaryLinks = await this.prisma.customerLink.findMany({
      where: { buyerAccountId: primaryAccount.id },
    });
    const primaryTenantIds = new Set(primaryLinks.map((l) => l.tenantId));

    const linksToTransfer = secondaryLinks.filter((l) => !primaryTenantIds.has(l.tenantId));
    const conflictingLinks = secondaryLinks.filter((l) => primaryTenantIds.has(l.tenantId));

    await this.prisma.$transaction(async (tx) => {
      // 1. Transfer non-conflicting CustomerLinks
      if (linksToTransfer.length > 0) {
        await tx.customerLink.updateMany({
          where: { id: { in: linksToTransfer.map((l) => l.id) } },
          data: { buyerAccountId: primaryAccount.id },
        });
      }

      // 2. Disconnect conflicting links
      if (conflictingLinks.length > 0) {
        await tx.customerLink.updateMany({
          where: { id: { in: conflictingLinks.map((l) => l.id) } },
          data: {
            status: "DISCONNECTED",
            disconnectedAt: new Date(),
            buyerAccountId: null,
          },
        });
      }

      // 3. Transfer googleId if primary has none and secondary has one
      if (!primaryAccount.googleId && secondaryAccount.googleId) {
        await tx.buyerAccount.update({
          where: { id: primaryAccount.id },
          data: { googleId: secondaryAccount.googleId },
        });
        await tx.buyerAccount.update({
          where: { id: secondaryAccount.id },
          data: { googleId: null },
        });
      }

      // 4. Invalidate all secondary's sessions
      await tx.buyerRefreshToken.deleteMany({
        where: { buyerAccountId: secondaryAccount.id },
      });

      // 5. Mark secondary as merged/deleted
      await tx.buyerAccount.update({
        where: { id: secondaryAccount.id },
        data: {
          status: "DELETED",
          deletedAt: new Date(),
          mergedIntoId: primaryAccount.id,
        },
      });

      // 6. Complete the merge request
      await tx.buyerMergeRequest.update({
        where: { id: mergeRequestId },
        data: { status: BuyerMergeRequestStatus.COMPLETED, completedAt: new Date() },
      });
    });

    // 7. Send notification emails (outside transaction)
    try {
      await this.emailService.sendMergeCompleteEmail({
        primaryEmail: primaryAccount.email,
        secondaryEmail: secondaryAccount.email,
        primaryName: primaryAccount.name ?? primaryAccount.email,
      });
    } catch (_) {
      // Email failure should not roll back the merge
    }

    return {
      success: true,
      message: "Merge completed successfully.",
      transferredLinks: linksToTransfer.length,
      disconnectedLinks: conflictingLinks.length,
    };
  }

  // ─── Admin: reject merge ──────────────────────────────────────────────────────

  async rejectMerge(mergeRequestId: string, adminNotes?: string) {
    const req = await this.prisma.buyerMergeRequest.findUnique({ where: { id: mergeRequestId } });
    if (!req) throw new NotFoundException("Merge request not found");
    if (req.status === BuyerMergeRequestStatus.COMPLETED) {
      throw new BadRequestException("Cannot reject a completed merge request");
    }
    if (req.status === BuyerMergeRequestStatus.REJECTED) {
      throw new BadRequestException("Merge request is already rejected");
    }

    return this.prisma.buyerMergeRequest.update({
      where: { id: mergeRequestId },
      data: {
        status: BuyerMergeRequestStatus.REJECTED,
        rejectedAt: new Date(),
        adminNotes: adminNotes ?? req.adminNotes,
      },
    });
  }
}
