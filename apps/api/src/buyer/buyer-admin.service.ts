import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import type { AppConfig } from "../config/configuration";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";

/**
 * SUPER_ADMIN buyer account management.
 */
@Injectable()
export class BuyerAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfig>,
  ) {}

  // ─── List buyer accounts ──────────────────────────────────────────────────────

  async listBuyers(query: { page?: number; limit?: number; search?: string; status?: string }) {
    const page = Number(query.page ?? 1);
    const limit = Math.min(Number(query.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: "insensitive" } },
        { name: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.buyerAccount.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          status: true,
          emailVerified: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
          _count: { select: { customerLinks: true } },
        },
      }),
      this.prisma.buyerAccount.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── Get single buyer ─────────────────────────────────────────────────────────

  async getBuyer(id: string) {
    const buyer = await this.prisma.buyerAccount.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        mobile: true,
        status: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        customerLinks: {
          include: {
            tenant: { select: { id: true, name: true, slug: true } },
            customer: { select: { id: true, businessName: true } },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!buyer) throw new NotFoundException("Buyer account not found");
    return buyer;
  }

  // ─── Set buyer status ─────────────────────────────────────────────────────────

  async setBuyerStatus(id: string, status: "ACTIVE" | "SUSPENDED" | "DELETED") {
    const buyer = await this.prisma.buyerAccount.findUnique({ where: { id } });
    if (!buyer) throw new NotFoundException("Buyer account not found");

    const data: any = { status };
    if (status === "DELETED") data.deletedAt = new Date();
    if (status === "ACTIVE") data.deletedAt = null;

    await this.prisma.buyerAccount.update({ where: { id }, data });
    return { id, status, message: `Buyer account ${status.toLowerCase()}` };
  }

  // ─── Impersonate buyer (issue buyer JWT) ──────────────────────────────────────

  async impersonateBuyer(id: string, adminId: string) {
    const buyer = await this.prisma.buyerAccount.findUnique({ where: { id } });
    if (!buyer) throw new NotFoundException("Buyer account not found");

    const jwtConfig = this.config.get<AppConfig["jwt"]>("jwt")!;
    const payload: BuyerJwtPayload & { impersonatedBy: string } = {
      sub: buyer.id,
      email: buyer.email,
      name: buyer.name,
      type: "BUYER",
      impersonatedBy: adminId,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: "15m", // match platform admin impersonation window
    });

    return {
      accessToken,
      buyer: { id: buyer.id, email: buyer.email, name: buyer.name },
      expiresIn: "15m",
      warning: "This token impersonates the buyer. Use responsibly.",
    };
  }

  // ─── List all customer links ───────────────────────────────────────────────────

  async listLinks(query: { page?: number; limit?: number; status?: string; tenantId?: string }) {
    const page = Number(query.page ?? 1);
    const limit = Math.min(Number(query.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.tenantId) where.tenantId = query.tenantId;

    const [data, total] = await Promise.all([
      this.prisma.customerLink.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          buyerAccount: { select: { id: true, email: true, name: true } },
          tenant: { select: { id: true, name: true, slug: true } },
          customer: { select: { id: true, businessName: true } },
        },
      }),
      this.prisma.customerLink.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── Link stats ───────────────────────────────────────────────────────────────

  async linkStats() {
    const [total, byStatus, recentLinks] = await Promise.all([
      this.prisma.customerLink.count(),
      this.prisma.customerLink.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      this.prisma.customerLink.count({
        where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      }),
    ]);

    const [totalBuyers, activeBuyers] = await Promise.all([
      this.prisma.buyerAccount.count({ where: { deletedAt: null } }),
      this.prisma.buyerAccount.count({ where: { status: "ACTIVE", deletedAt: null } }),
    ]);

    return {
      links: {
        total,
        last30Days: recentLinks,
        byStatus: byStatus.reduce(
          (acc, s) => ({ ...acc, [s.status]: s._count._all }),
          {} as Record<string, number>,
        ),
      },
      buyers: { total: totalBuyers, active: activeBuyers },
    };
  }

  // ─── Update buyer profile ─────────────────────────────────────────────────────

  async updateBuyer(
    id: string,
    dto: { name?: string; email?: string; phone?: string | null; mobile?: string | null },
  ) {
    const buyer = await this.prisma.buyerAccount.findUnique({ where: { id } });
    if (!buyer) throw new NotFoundException("Buyer account not found");

    if (dto.email && dto.email !== buyer.email) {
      const existing = await this.prisma.buyerAccount.findUnique({ where: { email: dto.email } });
      if (existing) throw new ConflictException("Email is already in use by another account");
    }

    const updated = await this.prisma.buyerAccount.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.email !== undefined && { email: dto.email, emailVerified: false }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.mobile !== undefined && { mobile: dto.mobile }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        mobile: true,
        status: true,
        emailVerified: true,
      },
    });

    return updated;
  }

  // ─── Add a seller link (link buyer to a tenant customer) ─────────────────────

  async addBuyerLink(buyerId: string, dto: { tenantId: string; customerId: string }) {
    const buyer = await this.prisma.buyerAccount.findUnique({ where: { id: buyerId } });
    if (!buyer) throw new NotFoundException("Buyer account not found");

    const tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenantId } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, tenantId: dto.tenantId },
    });
    if (!customer) throw new NotFoundException("Customer not found in that tenant");

    // Check for existing link on this customer (customerId is @unique in CustomerLink)
    const existing = await this.prisma.customerLink.findUnique({
      where: { customerId: dto.customerId },
    });
    if (existing) {
      if (existing.buyerAccountId === buyerId && existing.status === "ACTIVE") {
        throw new ConflictException("This buyer is already actively linked to this customer");
      }
      // Admin override: reassign the link to this buyer
      const updated = await this.prisma.customerLink.update({
        where: { id: existing.id },
        data: {
          buyerAccountId: buyerId,
          status: "ACTIVE",
          linkedAt: new Date(),
          disconnectedAt: null,
          disconnectedBy: null,
        },
        include: {
          tenant: { select: { id: true, name: true, slug: true } },
          customer: { select: { id: true, businessName: true } },
        },
      });
      return updated;
    }

    // Create fresh link
    const link = await this.prisma.customerLink.create({
      data: {
        buyerAccountId: buyerId,
        customerId: dto.customerId,
        tenantId: dto.tenantId,
        status: "ACTIVE",
        linkedAt: new Date(),
      },
      include: {
        tenant: { select: { id: true, name: true, slug: true } },
        customer: { select: { id: true, businessName: true } },
      },
    });
    return link;
  }

  // ─── Remove a seller link ─────────────────────────────────────────────────────

  async removeLink(linkId: string) {
    const link = await this.prisma.customerLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundException("Customer link not found");

    await this.prisma.customerLink.update({
      where: { id: linkId },
      data: {
        status: "DISCONNECTED",
        disconnectedAt: new Date(),
        buyerAccountId: null,
      },
    });
    return { id: linkId, message: "Link disconnected" };
  }

  // ─── List customers in a tenant (for link picker) ─────────────────────────────

  async getTenantCustomers(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException("Tenant not found");

    const customers = await this.prisma.customer.findMany({
      where: { tenantId },
      orderBy: { businessName: "asc" },
      select: {
        id: true,
        businessName: true,
        email: true,
        phone: true,
        customerLink: {
          select: {
            id: true,
            status: true,
            buyerAccountId: true,
            buyerAccount: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });

    return { tenantId, tenantName: tenant.name, customers };
  }
}
