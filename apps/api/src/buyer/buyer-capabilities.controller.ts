import { Controller, Get, UseGuards, UseInterceptors } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { BuyerSellerCapability } from "@routeflow/types";
import { FulfilmentCapabilityService } from "../billing/fulfilment-capability.service";
import { BuyerTenantInterceptor } from "./buyer-tenant.interceptor";
import { CurrentBuyerCustomer } from "./decorators/current-buyer.decorator";
import { BuyerJwtAuthGuard } from "./guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "./guards/buyer-seller-context.guard";

/**
 * Business profiles 1B: `GET /buyer/capabilities` — the SELLER's buyer-safe fulfilment facts. The
 * buyer portal can't read GET /tenants/me/features (staff JWT). It lives in its own controller so
 * BuyerController's constructor (which many specs build by hand) is untouched. It carries the same
 * class guard and per-route seller scoping as the buyer reads there.
 */
@ApiTags("buyer")
@Controller("buyer")
@UseGuards(BuyerJwtAuthGuard)
@ApiBearerAuth()
export class BuyerCapabilitiesController {
  constructor(private readonly fulfilmentCapability: FulfilmentCapabilityService) {}

  @Get("capabilities")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "The active seller's fulfilment capability (how its orders ship)" })
  getSellerCapabilities(
    @CurrentBuyerCustomer() ctx: { tenantId: string },
  ): Promise<BuyerSellerCapability> {
    // Exactly { portalMethods, portalDefault, fleet } — no staff fields.
    return this.fulfilmentCapability.forBuyer(ctx.tenantId);
  }
}
