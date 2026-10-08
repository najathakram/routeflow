import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { ProductUnitsService } from "./product-units.service";
import { CreateProductUnitDto, UpdateProductUnitDto } from "./dto/product-unit.dto";
import { ReplaceProductUnitsDto } from "./dto/replace-product-units.dto";

/**
 * Multi-level units (units_v1). The whole surface is plan-flag gated: a tenant without
 * `flag.units_v1` gets the structured PLAN_GATE 403, and no product ever grows a level.
 */
@Controller("products/:productId/units")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@RequirePlanFlag("flag.units_v1")
export class ProductUnitsController {
  constructor(private readonly units: ProductUnitsService) {}

  /** The tenant's unit names for the ladder editor's pickers (U-1's /units supersedes this read). */
  @Get("tenant-units")
  @Roles(UserRole.OPERATOR)
  tenantUnits() {
    return this.units.tenantUnitNames();
  }

  @Get()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  list(@Param("productId") productId: string) {
    return this.units.list(productId);
  }

  /** Replace the whole ladder (chain rows, base / pack words, level codes) in one transaction. */
  @Put()
  @Roles(UserRole.OPERATOR)
  replace(@Param("productId") productId: string, @Body() dto: ReplaceProductUnitsDto) {
    return this.units.replace(productId, dto);
  }

  @Post()
  @Roles(UserRole.OPERATOR)
  create(@Param("productId") productId: string, @Body() dto: CreateProductUnitDto) {
    return this.units.create(productId, dto);
  }

  @Patch(":unitId")
  @Roles(UserRole.OPERATOR)
  update(
    @Param("productId") productId: string,
    @Param("unitId") unitId: string,
    @Body() dto: UpdateProductUnitDto,
  ) {
    return this.units.update(productId, unitId, dto);
  }

  @Delete(":unitId")
  @Roles(UserRole.OPERATOR)
  remove(@Param("productId") productId: string, @Param("unitId") unitId: string) {
    return this.units.remove(productId, unitId);
  }
}
