import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UnitsService } from "./units.service";
import { CreateUnitDto } from "./dto/create-unit.dto";
import { UpdateUnitDto } from "./dto/update-unit.dto";

/**
 * Tenant unit names (Settings > Units). All staff (OPERATOR, which TENANT_ADMIN satisfies) may add,
 * rename, archive and restore; drivers and buyers may not. Not behind any plan flag or add-on.
 * Deliberately NO DELETE route: units are archived, never deleted.
 */
@Controller("units")
@UseGuards(JwtAuthGuard, RolesGuard)
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  list(@Query("includeArchived") includeArchived?: string) {
    return this.units.list(includeArchived === "1" || includeArchived === "true");
  }

  @Post()
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateUnitDto, @CurrentUser() user: JwtPayload) {
    return this.units.create(dto, user);
  }

  @Patch(":id")
  @Roles(UserRole.OPERATOR)
  update(@Param("id") id: string, @Body() dto: UpdateUnitDto, @CurrentUser() user: JwtPayload) {
    return this.units.update(id, dto, user);
  }
}
