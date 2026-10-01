import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { ProductFamiliesService } from "./product-families.service";
import { CreateFamilyDto, UpdateFamilyVariantsDto } from "./dto/family.dto";

/**
 * WS8 families API. Registered BEFORE ProductsController (products.module.ts; pinned in products-route-order.spec) so
 * `GET /products/sku-available` is never captured by `GET /products/:id`.
 */
@Controller("products")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductFamiliesController {
  constructor(private readonly families: ProductFamiliesService) {}

  @Get("sku-available")
  @Roles(UserRole.OPERATOR)
  skuAvailable(@Query("code") code: string, @Query("excludeProductId") excludeProductId?: string) {
    return this.families.skuAvailable(code, excludeProductId);
  }

  @Post("families")
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateFamilyDto, @CurrentUser() user: JwtPayload) {
    return this.families.createFamily(dto, user.sub ?? null);
  }

  @Patch(":id/variants")
  @Roles(UserRole.OPERATOR)
  variants(
    @Param("id") id: string,
    @Body() dto: UpdateFamilyVariantsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.families.updateVariants(id, dto, user.sub ?? null);
  }
}
