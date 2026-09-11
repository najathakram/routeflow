import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { BuyerJwtPayload } from "../interfaces/buyer-jwt-payload.interface";

/**
 * Resolves the buyer's active CustomerLink for the requested seller (X-Tenant-Slug).
 * Must run after BuyerJwtAuthGuard.
 * Sets req.buyerCustomer = { customerId, tenantId, tenantSlug, customer, userId }.
 */
@Injectable()
export class BuyerSellerContextGuard implements CanActivate {
  private readonly logger = new Logger(BuyerSellerContextGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const buyer = req.user as BuyerJwtPayload;
    const tenantSlug: string | undefined = req.headers["x-tenant-slug"];

    if (!tenantSlug) {
      throw new BadRequestException("X-Tenant-Slug header is required");
    }

    // Resolve tenant (unscoped — platform-level lookup)
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Seller not found");
    if (tenant.status === "SUSPENDED" || tenant.status === "CANCELLED") {
      throw new ForbiddenException("This seller account is not available");
    }

    // Verify active CustomerLink. REG-B141: removing a customer leaves its link ACTIVE on purpose (restore
    // must bring the portal back untouched), so the removal is enforced here, on every seller-scoped
    // request. No refresh-token revocation: BuyerRefreshToken is account-wide (no tenantId).
    const link = await this.prisma.customerLink.findFirst({
      where: {
        buyerAccountId: buyer.sub,
        tenantId: tenant.id,
        status: "ACTIVE",
        customer: { deletedAt: null },
      },
      include: {
        customer: {
          select: { id: true, userId: true, businessName: true, email: true },
        },
      },
    });

    if (!link) {
      // REG-B141 observability: this 403 is indistinguishable from a DISCONNECTED link on the wire, and the
      // API logs no requests, so name the removed-customer case once here (refusal path only — the happy
      // path still issues exactly one query).
      const removed = await this.prisma.customerLink.findFirst({
        where: { buyerAccountId: buyer.sub, tenantId: tenant.id, status: "ACTIVE" },
        select: { customerId: true, customer: { select: { deletedAt: true } } },
      });
      if (removed?.customer?.deletedAt) {
        this.logger.warn(
          `[B141] portal access refused: customer ${removed.customerId} at tenant ${tenant.id} is removed (buyer ${buyer.sub})`,
        );
      }
      throw new ForbiddenException("No active connection to this seller");
    }

    // Populate request for downstream handlers / BuyerTenantInterceptor
    req.buyerCustomer = {
      customerId: link.customerId,
      tenantId: tenant.id,
      tenantSlug,
      customer: link.customer,
      userId: link.customer.userId,
    };

    return true;
  }
}
