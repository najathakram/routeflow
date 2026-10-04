import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import type { PriceHistoryResponse, PriceSummaryResponse } from "@routeflow/types";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CustomerPriceHistoryService } from "./customer-price-history.service";

/**
 * Step 2A — one customer's price history for one product (order-entry popover). Staff only:
 * OPERATOR admits OPERATOR and TENANT_ADMIN through the RolesGuard hierarchy; a DRIVER or CUSTOMER
 * gets 403. Kept apart from CustomersController so that controller's constructor is untouched.
 */
@ApiTags("customers")
@ApiBearerAuth()
@Controller("customers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerPriceHistoryController {
  constructor(private readonly history: CustomerPriceHistoryService) {}

  @Get(":customerId/products/:productId/price-history")
  @Roles(UserRole.OPERATOR)
  getPriceHistory(
    @Param("customerId") customerId: string,
    @Param("productId") productId: string,
    @Query("limit") limit: string | undefined,
    @Query("compare") compare: string | undefined,
    @CurrentUser() user: JwtPayload,
  ): Promise<PriceHistoryResponse> {
    return this.history.getHistory(customerId, productId, { limit, compare, role: user.role });
  }

  /** v1.1: last 3 invoiced prices + low/high per product (max 50), one query pass. */
  @Get(":customerId/price-summary")
  @Roles(UserRole.OPERATOR)
  getPriceSummary(
    @Param("customerId") customerId: string,
    @Query("productIds") productIds: string | undefined,
    @CurrentUser() user: JwtPayload,
  ): Promise<PriceSummaryResponse> {
    return this.history.getPriceSummary(customerId, productIds, { role: user.role });
  }
}
