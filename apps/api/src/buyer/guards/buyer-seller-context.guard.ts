import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
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

    // Verify active CustomerLink
    const link = await this.prisma.customerLink.findFirst({
      where: { buyerAccountId: buyer.sub, tenantId: tenant.id, status: "ACTIVE" },
      include: {
        customer: {
          select: { id: true, userId: true, businessName: true, email: true },
        },
      },
    });

    if (!link) {
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
