import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { ProductAliasService } from "./product-alias.service";
import { CreateAliasDto } from "./dto/create-alias.dto";

/**
 * Manage learned line-text → product/expense-category aliases (spec §5.3). Lets
 * an operator review and correct what the batch importer has learned.
 * TENANT_ADMIN satisfies @Roles(OPERATOR).
 */
@Controller("import/aliases")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class AliasController {
  constructor(private readonly aliases: ProductAliasService) {}

  @Get()
  list(@Query("search") search?: string) {
    return this.aliases.list(search);
  }

  @Post()
  async create(@Body() dto: CreateAliasDto) {
    await this.aliases.learn(dto.supplierId, dto.rawText, {
      productId: dto.productId,
      expenseCategoryId: dto.expenseCategoryId,
    });
    return { ok: true };
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.aliases.remove(id);
  }
}
