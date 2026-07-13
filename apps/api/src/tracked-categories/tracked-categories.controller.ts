import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { TrackedCategoriesService } from "./tracked-categories.service";
import { CreateTrackedCategoryDto } from "./dto/create-tracked-category.dto";
import { UpdateTrackedCategoryDto } from "./dto/update-tracked-category.dto";
import { ListTrackedCategoriesDto } from "./dto/list-tracked-categories.dto";
import { AssignProductsDto } from "./dto/assign-products.dto";
import { CreateSubcategoryDto } from "./dto/create-subcategory.dto";
import { UpdateSubcategoryDto } from "./dto/update-subcategory.dto";

// TENANT_ADMIN satisfies OPERATOR via the RolesGuard hierarchy, so both roles
// can manage categories; SUPER_ADMIN too. Generic feature — no addon gate.
@Controller("tracked-categories")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class TrackedCategoriesController {
  constructor(private readonly service: TrackedCategoriesService) {}

  @Get()
  findAll(@Query() query: ListTrackedCategoriesDto) {
    return this.service.findAll(query);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateTrackedCategoryDto) {
    return this.service.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateTrackedCategoryDto) {
    return this.service.update(id, dto);
  }

  @Patch(":id/toggle")
  toggle(@Param("id") id: string) {
    return this.service.toggle(id);
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
