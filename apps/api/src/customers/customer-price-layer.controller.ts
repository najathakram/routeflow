import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { CustomerPriceLayerResponse } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { CustomerUnitPricesService } from "./customer-unit-prices.service";

/**
 * Units v2 (S19b A1): one customer's price LAYER, billing's own resolved rows, for the order, invoice and estimate screens.
 * Same guards and flag as K6's `/unit-prices` (class-level, so a flag-off tenant gets the PLAN_GATE 403); a separate
 * controller so K6's read-only route list is untouched. The tenant comes from the JWT only.
 */
@Controller("customers/:customerId/price-layer")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@RequirePlanFlag("flag.units_prices_v2")
export class CustomerPriceLayerController {
  constructor(private readonly prices: CustomerUnitPricesService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  layer(@Param("customerId") customerId: string): Promise<CustomerPriceLayerResponse> {
    return this.prices.priceLayer(customerId);
  }
}
