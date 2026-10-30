import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { TrackedCategoriesService } from "./tracked-categories.service";
import { CreateTrackedCategoryDto } from "./dto/create-tracked-category.dto";
import { UpdateTrackedCategoryDto } from "./dto/update-tracked-category.dto";
import { ListTrackedCategoriesDto } from "./dto/list-tracked-categories.dto";
import { AssignProductsDto } from "./dto/assign-products.dto";
import { CreateSubcategoryDto } from "./dto/create-subcategory.dto";
import { UpdateSubcategoryDto } from "./dto/update-subcategory.dto";

import { RequirePermission, PermissionBase } from "../auth/permissions/permission.decorators";
// TENANT_ADMIN satisfies OPERATOR via the RolesGuard hierarchy, so both roles
// can manage categories; SUPER_ADMIN too. Generic feature — no addon gate.
@RequirePermission("REGULATED")
@Controller("tracked-categories")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class TrackedCategoriesController {
  constructor(private readonly service: TrackedCategoriesService) {}

  @PermissionBase("cross-cutting lookup other areas need (spec-operator-permissions §4.3)")
  @Get()
  findAll(@Query() query: ListTrackedCategoriesDto) {
    return this.service.findAll(query);
  }

  @PermissionBase("cross-cutting lookup other areas need (spec-operator-permissions §4.3)")
  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateTrackedCategoryDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateTrackedCategoryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user);
  }

  @Patch(":id/toggle")
  toggle(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.service.toggle(id, user);
  }

  @Post(":id/products/assign")
  assign(@Param("id") id: string, @Body() dto: AssignProductsDto) {
    return this.service.assignProducts(id, dto.productIds);
  }

  @Post(":id/products/unassign")
  unassign(@Param("id") id: string, @Body() dto: AssignProductsDto) {
    return this.service.unassignProducts(id, dto.productIds);
  }

  // ── Subcategories (nested under a section) ────────────────────────────────

  @Get(":id/subcategories")
  listSubcategories(@Param("id") id: string) {
    return this.service.listSubcategories(id);
  }

  @Post(":id/subcategories")
  createSubcategory(@Param("id") id: string, @Body() dto: CreateSubcategoryDto) {
    return this.service.createSubcategory(id, dto);
  }

  @Patch(":id/subcategories/:subId")
  updateSubcategory(
    @Param("id") id: string,
    @Param("subId") subId: string,
    @Body() dto: UpdateSubcategoryDto,
  ) {
    return this.service.updateSubcategory(id, subId, dto);
  }

  @Patch(":id/subcategories/:subId/toggle")
  toggleSubcategory(@Param("id") id: string, @Param("subId") subId: string) {
    return this.service.toggleSubcategory(id, subId);
  }
}
