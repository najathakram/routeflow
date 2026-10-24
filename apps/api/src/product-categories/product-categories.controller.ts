import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { ProductCategoriesService } from "./product-categories.service";
import { ProductLabelsAdminService } from "./product-labels-admin.service";
import { CreateProductCategoryDto } from "./dto/create-product-category.dto";
import { UpdateProductCategoryDto } from "./dto/update-product-category.dto";
import { SetProductLabelDto } from "./dto/set-product-label.dto";

// Reads: OPERATOR (TENANT_ADMIN/SUPER_ADMIN satisfy it via the RolesGuard hierarchy).
// Writes: TENANT_ADMIN — a label decides what a ban covers.
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductCategoriesController {
  constructor(
    private readonly categories: ProductCategoriesService,
    private readonly labels: ProductLabelsAdminService,
  ) {}

  @Get("product-categories")
  @Roles(UserRole.OPERATOR)
  list(@Query("includeArchived") includeArchived?: string) {
    return this.categories.list(includeArchived === "true");
  }

  @Post("product-categories")
  @Roles(UserRole.TENANT_ADMIN)
  create(@Body() dto: CreateProductCategoryDto, @CurrentUser() user: JwtPayload) {
    return this.categories.create(dto, user);
  }

  @Patch("product-categories/:id")
  @Roles(UserRole.TENANT_ADMIN)
  update(
    @Param("id") id: string,
    @Body() dto: UpdateProductCategoryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.categories.update(id, dto, user);
  }

  @Get("products/:productId/labels")
  @Roles(UserRole.OPERATOR)
  getLabels(@Param("productId") productId: string) {
    return this.labels.getForProduct(productId);
  }

  @Put("products/:productId/labels/:categoryId")
  // Owner ruling 2026-10-14: operators too; a federal-covered label stays admin-only (the service checks).
  @Roles(UserRole.OPERATOR)
  setLabel(
    @Param("productId") productId: string,
    @Param("categoryId") categoryId: string,
    @Body() dto: SetProductLabelDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.labels.setLabel(productId, categoryId, dto, user);
  }

  @Delete("products/:productId/labels/:categoryId")
  // Owner ruling 2026-10-14: operators too; a federal-covered label stays admin-only (the service checks).
  @Roles(UserRole.OPERATOR)
  removeLabel(
    @Param("productId") productId: string,
    @Param("categoryId") categoryId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.labels.removeLabel(productId, categoryId, user);
  }
}
