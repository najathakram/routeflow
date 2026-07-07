import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { SubscriptionService } from "./subscription.service";
import { ProrationService } from "./proration.service";
import { QuoteDto } from "./dto/quote.dto";

interface AuthUser {
  tenantId: string | null;
}

/**
 * Tenant self-service billing (settings-billing + choose-plan). Authenticated
 * operators/admins only. Read + quote surface — the subscribe/upgrade/downgrade
 * mutations land in Phase 4. (Public pricing lives on GET /billing/plans.)
 */
@ApiTags("billing")
@ApiBearerAuth()
@Controller("billing")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class SettingsBillingController {
  constructor(
    private readonly subscription: SubscriptionService,
    private readonly proration: ProrationService,
  ) {}

  /**
   * These are TENANT self-service views. A platform SUPER_ADMIN satisfies
   * @Roles(OPERATOR) via the role hierarchy but carries no tenant context — reject
   * it explicitly rather than laundering a null tenantId into the query layer (500).
   */
  private tenantIdOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException("This billing view requires a tenant context.");
    }
    return user.tenantId;
  }

  @Get("subscription")
  @ApiOperation({ summary: "The tenant's current plan, add-ons and renewal state" })
  getSubscription(@CurrentUser() user: AuthUser) {
    return this.subscription.getSubscription(this.tenantIdOf(user));
  }

  @Get("usage")
  @ApiOperation({ summary: "Current-cycle meter usage (seats/routes/scans/msgs)" })
  getUsage(@CurrentUser() user: AuthUser) {
    return this.subscription.getUsage(this.tenantIdOf(user));
  }

  @Get("recommendation")
  @ApiOperation({ summary: "Usage-fit plan recommendation for choose-plan" })
  getRecommendation(@CurrentUser() user: AuthUser) {
    return this.subscription.getRecommendation(this.tenantIdOf(user));
  }

  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Price a plan + add-on selection at a cycle (choose-plan)" })
  quote(@Body() dto: QuoteDto) {
    return this.proration.quote(dto);
  }

  @Get("proration-preview")
  @ApiOperation({ summary: "Mid-cycle prorated charge to enable an add-on today" })
  prorationPreview(@CurrentUser() user: AuthUser, @Query("sku") sku: string) {
    return this.proration.prorationPreview(this.tenantIdOf(user), sku);
  }
}
