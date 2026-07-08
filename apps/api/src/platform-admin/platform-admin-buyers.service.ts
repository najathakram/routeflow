import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Read-only aggregation for the platform-admin Buyers screen.
 *
 * The buyer-account / merge write endpoints live in apps/api/src/buyer (a module
 * this session must not edit, and whose BuyerMergeService is not exported). This
 * service therefore reads the shared models (BuyerAccount, CustomerLink, Order,
 * BuyerMergeRequest) directly via PrismaService to compute the enrichment the
 * design needs — business name, active-seller count, orders in the last 90 days,
 * and pending-merge summaries. It performs NO writes; approve/reject/suspend
 * continue to flow through the existing buyer-module endpoints from the client.
 */
@Injectable()
export class PlatformAdminBuyersService {
  constructor(private readonly prisma: PrismaService) {}

  private ninetyDaysAgo(): Date {
    return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  }

  /** Collapse a buyer's ACTIVE links into { businessName, sellers, orders90d }. */
  private summarize(
    links: Array<{
      tenantId: string;
      customer: { businessName: string; _count: { orders: number } } | null;
    }>,
  ) {
    const sellers = new Set(links.map((l) => l.tenantId)).size;
    const orders90d = links.reduce((sum, l) => sum + (l.customer?._count.orders ?? 0), 0);
    const businessName = links.find((l) => l.customer)?.customer?.businessName ?? null;
    return { sellers, orders90d, businessName };
  }

  // ─── Buyer directory ──────────────────────────────────────────────────────

  async getBuyerDirectory(opts: {
    page?: number;
    limit?: number;
    search?: string | null;
    segment?: string | null;
  }) {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 25;
    const skip = (page - 1) * limit;
    const ninety = this.ninetyDaysAgo();

    // Buyer accounts with more than one ACTIVE seller link (for the Multi-seller chip).
    const multiSellerGroups = await this.prisma.customerLink.groupBy({
      by: ["buyerAccountId"],
      where: {
        status: "ACTIVE",
        buyerAccountId: { not: null },
        // Match the directory's baseWhere so the chip count agrees with the list
        // (admin Delete sets the buyer DELETED but leaves its links ACTIVE).
        buyerAccount: { is: { deletedAt: null, status: { not: "DELETED" } } },
      },
      _count: { buyerAccountId: true },
      having: { buyerAccountId: { _count: { gt: 1 } } },
    });
    const multiSellerIds = multiSellerGroups
      .map((g) => g.buyerAccountId)
      .filter((id): id is string => !!id);

    const baseWhere: Record<string, unknown> = { deletedAt: null, status: { not: "DELETED" } };
    if (opts.search) {
      const q = opts.search.trim();
      baseWhere.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ];
    }

    const where: Record<string, unknown> = { ...baseWhere };
    if (opts.segment === "unverified") where.emailVerified = false;
    if (opts.segment === "multi-seller") where.id = { in: multiSellerIds };

    const [rows, total, allCount, unverifiedCount] = await Promise.all([
      this.prisma.buyerAccount.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          name: true,
          status: true,
          emailVerified: true,
          createdAt: true,
          customerLinks: {
            where: { status: "ACTIVE" },
            orderBy: { createdAt: "asc" },
            select: {
              tenantId: true,
              customer: {
                select: {
                  businessName: true,
                  _count: { select: { orders: { where: { createdAt: { gte: ninety } } } } },
                },
              },
            },
          },
        },
      }),
      this.prisma.buyerAccount.count({ where }),
      this.prisma.buyerAccount.count({ where: baseWhere }),
      this.prisma.buyerAccount.count({ where: { ...baseWhere, emailVerified: false } }),
    ]);

    const data = rows.map((b) => {
      const { sellers, orders90d, businessName } = this.summarize(b.customerLinks);
      return {
        id: b.id,
        email: b.email,
        name: b.name,
        status: b.status,
        emailVerified: b.emailVerified,
        createdAt: b.createdAt,
        businessName,
        sellers,
        orders90d,
      };
    });

    return {
      data,
      // Chip counts are global (not narrowed by the current search), matching the design.
      segments: { all: allCount, multiSeller: multiSellerIds.length, unverified: unverifiedCount },
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  // ─── Pending merge summary ────────────────────────────────────────────────

  async getPendingMergeSummary(opts: { limit?: number } = {}) {
    const limit = opts.limit ?? 20;
    const ninety = this.ninetyDaysAgo();

    const accountSelect = {
      id: true,
      email: true,
      name: true,
      customerLinks: {
        where: { status: "ACTIVE" as const },
        orderBy: { createdAt: "asc" as const },
        select: {
          tenantId: true,
          customer: {
            select: {
              businessName: true,
              _count: { select: { orders: { where: { createdAt: { gte: ninety } } } } },
            },
          },
        },
      },
    };

    const [requests, pendingCount] = await Promise.all([
      this.prisma.buyerMergeRequest.findMany({
        where: { status: "PENDING_REVIEW" },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          status: true,
          initiatedBy: true,
          initiatorNotes: true,
          createdAt: true,
          primaryAccount: { select: accountSelect },
          secondaryAccount: { select: accountSelect },
        },
      }),
      this.prisma.buyerMergeRequest.count({ where: { status: "PENDING_REVIEW" } }),
    ]);

    const data = requests.map((r) => {
      const primary = this.summarize(r.primaryAccount.customerLinks);
      const secondary = this.summarize(r.secondaryAccount.customerLinks);
      return {
        id: r.id,
        status: r.status,
        initiatedBy: r.initiatedBy,
        initiatorNotes: r.initiatorNotes,
        createdAt: r.createdAt,
        primary: {
          id: r.primaryAccount.id,
          email: r.primaryAccount.email,
          name: r.primaryAccount.name,
          sellers: primary.sellers,
          orders90d: primary.orders90d,
        },
        secondary: {
          id: r.secondaryAccount.id,
          email: r.secondaryAccount.email,
          name: r.secondaryAccount.name,
          sellers: secondary.sellers,
          orders90d: secondary.orders90d,
        },
      };
    });

    return { data, pendingCount };
  }
}
