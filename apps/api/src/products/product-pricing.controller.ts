import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { ProductPriceGridService } from "./product-price-grid.service";

/**
 * Units and prices v2. The whole surface is plan-flag gated: a tenant without
 * `flag.units_prices_v2` gets the structured PLAN_GATE 403 (SA-796 R-5: enforced, not dark).
 * TENANT_ADMIN satisfies OPERATOR in RolesGuard.
 */
@Controller("products/:productId")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@RequirePlanFlag("flag.units_prices_v2")
export class ProductPricingController {
  constructor(private readonly grid: ProductPriceGridService) {}

  @Get("price-grid")
  @Roles(UserRole.OPERATOR)
  priceGrid(@Param("productId") productId: string) {
    return this.grid.get(productId);
  }
}
