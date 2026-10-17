import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { CustomerUnitPricesResponse } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { CustomerUnitPricesService } from "./customer-unit-prices.service";
import { CustomerUnitPricesQueryDto } from "./dto/customer-unit-prices-query.dto";

/**
 * Units v2 (K6, S20-read): what one customer pays per unit, product by product. Read-only; the same plan flag gate as
 * the price-grid route (`flag.units_prices_v2`, enforced: PLAN_GATE 403). The tenant comes from the JWT only (the
 * service reads through `forTenant()`); TENANT_ADMIN satisfies OPERATOR in RolesGuard.
 */
@Controller("customers/:customerId/unit-prices")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@RequirePlanFlag("flag.units_prices_v2")
export class CustomerUnitPricesController {
  constructor(private readonly prices: CustomerUnitPricesService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  list(
    @Param("customerId") customerId: string,
    @Query() query: CustomerUnitPricesQueryDto,
  ): Promise<CustomerUnitPricesResponse> {
    return this.prices.get(customerId, query);
  }
}
