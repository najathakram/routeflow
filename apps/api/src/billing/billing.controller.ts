import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { BillingService } from "./billing.service";
import { MrrService } from "./mrr.service";
import { CreateCheckoutDto } from "./dto/create-checkout.dto";

/**
 * Billing endpoints used by platform admins to manage tenant subscriptions.
 *
 * All routes require SUPER_ADMIN authentication.
 */
@ApiTags("billing")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("billing")
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly mrr: MrrService,
  ) {}

  @Get("admin/mrr")
  @ApiOperation({
    summary: "Server-side MRR rollup = Σ(base + add-ons − discounts) + reconciliation",
  })
  getMrr() {
    return this.mrr.computeOverview();
  }

  @Get("tenants/:tenantId")
  @ApiOperation({ summary: "Get billing info for a tenant" })
  getTenantBilling(@Param("tenantId") tenantId: string) {
    return this.billingService.getTenantBillingInfo(tenantId);
  }

  @Post("checkout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Create a Stripe Checkout session for a tenant to subscribe",
  })
  createCheckout(@Body() dto: CreateCheckoutDto) {
    return this.billingService.createCheckoutSession(dto.tenantId, {
      successUrl: dto.successUrl,
      cancelUrl: dto.cancelUrl,
    });
  }

  @Post("tenants/:tenantId/portal")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Create a Stripe Billing Portal session for a tenant",
  })
  createPortal(@Param("tenantId") tenantId: string) {
    return this.billingService.createBillingPortalSession(tenantId);
  }

  @Post("tenants/:tenantId/ensure-customer")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Ensure the tenant has a Stripe customer (creates one if missing)",
  })
  async ensureCustomer(@Param("tenantId") tenantId: string) {
    const customerId = await this.billingService.ensureStripeCustomer(tenantId);
    return { stripeCustomerId: customerId };
  }
}
