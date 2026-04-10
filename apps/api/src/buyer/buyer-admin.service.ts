import { Injectable, NotFoundException } from "@nestjs/common";
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

  async listBuyers(query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }) {
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
      expiresIn: "1h", // short-lived for safety
    });

    return {
      accessToken,
      buyer: { id: buyer.id, email: buyer.email, name: buyer.name },
      expiresIn: "1h",
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
}
