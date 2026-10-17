import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { SavePricesDto, UndoPricesDto } from "./dto/save-prices.dto";
import { ProductCustomerPricesService } from "./product-customer-prices.service";
import { ProductPriceGridService } from "./product-price-grid.service";
import { ProductPriceWriteService } from "./product-price-write.service";

/**
 * Units and prices v2. The whole surface is plan-flag gated: a tenant without
 * `flag.units_prices_v2` gets the structured PLAN_GATE 403 (SA-796 R-5: enforced, not dark).
 * TENANT_ADMIN satisfies OPERATOR in RolesGuard.
 */
@Controller("products/:productId")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@RequirePlanFlag("flag.units_prices_v2")
export class ProductPricingController {
  constructor(
    private readonly grid: ProductPriceGridService,
    private readonly writes: ProductPriceWriteService,
    private readonly customers: ProductCustomerPricesService,
  ) {}

  @Get("price-grid")
  @Roles(UserRole.OPERATOR)
  priceGrid(@Param("productId") productId: string) {
    return this.grid.get(productId);
  }

  /** The customers holding typed prices on this product, in the shape the planners take (capped at 500). */
  @Get("customer-prices")
  @Roles(UserRole.OPERATOR)
  customerPrices(@Param("productId") productId: string) {
    return this.customers.get(productId);
  }

  /** One Save: patches, keeps, customer moves, one audit row, priceRevision + 1 (SA-799 b). */
  @Post("prices")
  @HttpCode(200)
  @Roles(UserRole.OPERATOR)
  savePrices(
    @Param("productId") productId: string,
    @Body() dto: SavePricesDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.writes.save(productId, dto, user.sub);
  }

  /** Undo = the stored inverse of one Save, once, under the same precondition. */
  @Post("prices/undo")
  @HttpCode(200)
  @Roles(UserRole.OPERATOR)
  undoPrices(
    @Param("productId") productId: string,
    @Body() dto: UndoPricesDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.writes.undo(productId, dto, user.sub);
  }
}
