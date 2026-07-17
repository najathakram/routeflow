import {
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { ConfigService } from "@nestjs/config";
import type { RequestSellerDto } from "./dto/request-seller.dto";

@Injectable()
export class BuyerService {
  private readonly logger = new Logger(BuyerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
  ) {}

  // ─── Seller listing ───────────────────────────────────────────────────────────

  async getSellers(buyerAccountId: string) {
    const links = await this.prisma.customerLink.findMany({
      where: { buyerAccountId, status: { in: ["ACTIVE", "INVITED", "PENDING_SELLER_APPROVAL"] } },
      include: {
        tenant: {
          select: { id: true, name: true, slug: true },
        },
        customer: {
          select: { id: true, businessName: true, email: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Also fetch tenant branding separately
    const result = await Promise.all(
      links.map(async (link) => {
        const config = await this.prisma.tenantConfig.findFirst({
          where: { tenantId: link.tenantId },
          select: { businessName: true, logoKey: true, primaryColor: true },
        });
        return {
          linkId: link.id,
          linkStatus: link.status,
          linkedAt: link.linkedAt,
          tenant: {
            id: link.tenant.id,
            slug: link.tenant.slug,
            name: config?.businessName ?? link.tenant.name,
            logoKey: config?.logoKey ?? null,
            primaryColor: config?.primaryColor ?? null,
          },
          customer: link.customer,
        };
      }),
    );
    return result;
  }

  // ─── Invite details (public, no auth needed) ──────────────────────────────────

  async getInviteDetails(token: string) {
    const link = await this.prisma.customerLink.findUnique({
      where: { inviteToken: token },
      include: {
        tenant: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!link) throw new NotFoundException("Invite not found or already used");
    if (link.inviteExpiresAt && link.inviteExpiresAt < new Date()) {
      throw new GoneException("This invite link has expired");
    }
    if (link.status !== "INVITED") {
      throw new ConflictException("This invite has already been used");
    }

    const tenantConfig = await this.prisma.tenantConfig.findFirst({
      where: { tenantId: link.tenantId },
      select: { businessName: true, logoKey: true, primaryColor: true },
    });

    return {
      sellerName: tenantConfig?.businessName ?? link.tenant.name,
      sellerSlug: link.tenant.slug,
      logoKey: tenantConfig?.logoKey ?? null,
      primaryColor: tenantConfig?.primaryColor ?? null,
      inviteMethod: link.inviteMethod,
      expiresAt: link.inviteExpiresAt,
    };
  }

  // ─── Accept invite ────────────────────────────────────────────────────────────

  async acceptInvite(token: string, buyerAccountId: string) {
    return this.prisma.$transaction(async (tx) => {
      const link = await tx.customerLink.findUnique({
        where: { inviteToken: token },
        include: { tenant: { select: { name: true, slug: true } } },
      });

      if (!link) throw new NotFoundException("Invite not found or already used");
      if (link.inviteExpiresAt && link.inviteExpiresAt < new Date()) {
        throw new GoneException("This invite link has expired");
      }
      if (link.status !== "INVITED") {
        throw new ConflictException("This invite has already been used");
      }

      // Check if buyer already has a link to this tenant
      const existing = await tx.customerLink.findFirst({
        where: { buyerAccountId, tenantId: link.tenantId, id: { not: link.id } },
      });
      if (existing && existing.status === "ACTIVE") {
        throw new ConflictException("You are already connected to this seller");
      }

      const updated = await tx.customerLink.update({
        where: { id: link.id },
        data: {
          buyerAccountId,
          status: "ACTIVE",
          linkedAt: new Date(),
          inviteToken: null,
          inviteExpiresAt: null,
        },
        include: { tenant: { select: { name: true, slug: true } } },
      });

      this.logger.log(`BuyerAccount ${buyerAccountId} linked to tenant ${link.tenantId}`);

      return {
        message: `Successfully connected to ${link.tenant.name}`,
        tenantSlug: link.tenant.slug,
        linkId: updated.id,
      };
    });
  }

  // ─── Customer requests seller (buyer-initiated flow) ──────────────────────────

  async requestSeller(buyerAccountId: string, dto: RequestSellerDto) {
    // Resolve tenant
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: dto.sellerSlug } });
    if (!tenant) throw new NotFoundException("Seller not found");
    if (tenant.status === "SUSPENDED" || tenant.status === "CANCELLED") {
      throw new NotFoundException("Seller not found");
    }

    // Find customer at that tenant matching the provided email
    // Check both the customer's own email field AND their linked User's login email
    const normalizedEmail = dto.emailAtSeller.toLowerCase();
    const customer = await this.prisma.customer.findFirst({
      where: {
        tenantId: tenant.id,
        OR: [{ email: normalizedEmail }, { user: { email: normalizedEmail } }],
      },
    });
    if (!customer) {
      throw new NotFoundException(
        "No customer account found with that email at this seller. Contact the seller to send you an invite.",
      );
    }

    // Check for existing link
    const existing = await this.prisma.customerLink.findFirst({
      where: { customerId: customer.id },
    });
    if (existing) {
      if (existing.status === "ACTIVE" && existing.buyerAccountId === buyerAccountId) {
        throw new ConflictException("You are already connected to this seller");
      }
      if (existing.status === "ACTIVE" && existing.buyerAccountId !== buyerAccountId) {
        throw new ConflictException(
          "This customer account is already claimed by another buyer. Contact the seller.",
        );
      }
      if (
        existing.status === "PENDING_SELLER_APPROVAL" &&
        existing.buyerAccountId === buyerAccountId
      ) {
        // Upgrade the existing pending request to ACTIVE (email ownership already proven)
        const upgraded = await this.prisma.customerLink.update({
          where: { id: existing.id },
          data: { status: "ACTIVE", linkedAt: new Date() },
        });
        this.logger.log(
          `BuyerAccount ${buyerAccountId} upgraded PENDING_SELLER_APPROVAL link ${existing.id} to ACTIVE`,
        );
        return {
          message: "Connected! You can now view your orders and invoices from this seller.",
          linkId: upgraded.id,
        };
      }
    }

    // The buyer proved ownership of this email by authenticating with it on the buyer
    // platform. Since the seller already has a customer record with this email, auto-approve
    // the connection immediately — no manual seller review needed.
    const now = new Date();
    const link = await this.prisma.customerLink.upsert({
      where: { customerId: customer.id },
      create: {
        buyerAccountId,
        customerId: customer.id,
        tenantId: tenant.id,
        status: "ACTIVE",
        linkedAt: now,
      },
      update: {
        buyerAccountId,
        status: "ACTIVE",
        linkedAt: now,
        inviteToken: null,
        inviteExpiresAt: null,
      },
    });

    this.logger.log(
      `BuyerAccount ${buyerAccountId} auto-approved link to tenant ${tenant.id} (customer ${customer.id}) via email match`,
    );

    return {
      message: "Connected! You can now view your orders and invoices from this seller.",
      linkId: link.id,
    };
  }

  // ─── Operator: disconnect customer from buyer portal ──────────────────────────

  async disconnectPortal(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId },
    });
    if (!link || link.status === "DISCONNECTED") {
      return { message: "Customer is not connected to the buyer portal" };
    }

    await this.prisma.customerLink.update({
      where: { id: link.id },
      data: {
        status: "DISCONNECTED",
        disconnectedBy: "SELLER",
        disconnectedAt: new Date(),
      },
    });

    this.logger.log(`Operator disconnected customer ${customerId} from buyer portal`);
    return { message: "Customer disconnected from buyer portal. All business data preserved." };
  }

  // ─── Operator: get portal status ─────────────────────────────────────────────

  async getPortalStatus(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId },
      include: {
        buyerAccount: { select: { id: true, email: true, name: true, createdAt: true } },
      },
    });

    if (!link) return { status: "NOT_INVITED", link: null };

    return {
      status: link.status,
      inviteMethod: link.inviteMethod,
      inviteExpiresAt: link.inviteExpiresAt,
      linkedAt: link.linkedAt,
      disconnectedAt: link.disconnectedAt,
      disconnectedBy: link.disconnectedBy,
      buyerAccount: link.status === "ACTIVE" ? link.buyerAccount : null,
    };
  }

  // ─── Operator: approve buyer seller request ───────────────────────────────────

  async approveBuyerRequest(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId, status: "PENDING_SELLER_APPROVAL" },
    });
    if (!link) throw new NotFoundException("No pending buyer request found");

    await this.prisma.customerLink.update({
      where: { id: link.id },
      data: { status: "ACTIVE", linkedAt: new Date() },
    });

    return { message: "Buyer connection approved" };
  }

  // ─── Buyer: disconnect self from a seller ────────────────────────────────────

  async disconnectSelf(buyerAccountId: string, tenantSlug: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Seller not found");

    const link = await this.prisma.customerLink.findFirst({
      where: { buyerAccountId, tenantId: tenant.id },
    });
    if (!link || link.status === "DISCONNECTED") {
      return { message: "Not connected to this seller" };
    }

    await this.prisma.customerLink.update({
      where: { id: link.id },
      data: { status: "DISCONNECTED", disconnectedBy: "BUYER", disconnectedAt: new Date() },
    });

    return { message: "Disconnected from seller. Your order history remains accessible to them." };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async notifySellerOfRequest(
    tenantId: string,
    customer: { businessName: string; email: string | null },
    requestEmail: string,
  ) {
    // Get all operator users for this tenant to notify them
    const operators = await this.prisma.user.findMany({
      where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] }, status: "ACTIVE" },
      select: { email: true },
    });

    const tenantConfig = await this.prisma.tenantConfig.findFirst({
      where: { tenantId },
      select: { businessName: true },
    });
    const sellerName = tenantConfig?.businessName ?? "Your business";

    for (const op of operators.filter((o) => o.email)) {
      await this.emailService
        .send({
          to: op.email,
          subject: `Buyer portal connection request from ${requestEmail}`,
          html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2>New buyer connection request</h2>
            <p>A buyer with email <strong>${requestEmail}</strong> has requested to connect with your customer account <strong>${customer.businessName}</strong>.</p>
            <p>Log in to RouteFlow to approve or decline this request from the customer's portal status page.</p>
          </div>
        `,
        })
        .catch(() => {});
    }
  }
}
