import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RecipesService } from "./recipes.service";
import { CreateRecipeDto, UpdateRecipeDto } from "./dto/recipe.dto";

/**
 * #2717 M2: recipe routes. Staff-only like the product write routes; every method is additionally
 * gated inside RecipesService on the tenant's `mixed_packs` mode being on (403 otherwise).
 */
@Controller("recipes")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  list(@Query("productId") productId?: string) {
    return this.recipes.list(productId);
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR)
  findOne(@Param("id") id: string) {
    return this.recipes.findOne(id);
  }

  @Post()
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateRecipeDto, @CurrentUser() user: { id?: string }) {
    return this.recipes.create(dto, user?.id ?? null);
  }

  @Patch(":id")
  @Roles(UserRole.OPERATOR)
  update(@Param("id") id: string, @Body() dto: UpdateRecipeDto) {
    return this.recipes.update(id, dto);
  }

  @Post(":id/versions")
  @Roles(UserRole.OPERATOR)
  createVersion(@Param("id") id: string, @CurrentUser() user: { id?: string }) {
    return this.recipes.createVersion(id, user?.id ?? null);
  }

  @Post(":id/activate")
  @Roles(UserRole.OPERATOR)
  activate(@Param("id") id: string) {
    return this.recipes.activate(id);
  }
}
