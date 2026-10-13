import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { UnitsService } from "./units.service";
import { CreateUnitDto } from "./dto/create-unit.dto";
import { UpdateUnitDto } from "./dto/update-unit.dto";

/**
 * Tenant unit names (Settings > Units). All staff (OPERATOR, which TENANT_ADMIN satisfies) may add,
 * rename, archive and restore; drivers and buyers may not. Deliberately NO DELETE route: units are
 * archived, never deleted.
 *
 * Gated on `flag.units_settings_v1` (ENFORCED, never default-granted: invisible and refused until the
 * owner grants it to a tenant; `flag.units_v1` alone does NOT open it, it already runs on a live tenant). A rename reaches a level only through `ProductUnit.tenantUnitId`; levels that predate the
 * link (and the unit names behind them) are filled in by the U-6 backfill, so the owner grants the
 * flag to a tenant only after that backfill has run for it.
 */
@Controller("units")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@RequirePlanFlag("flag.units_settings_v1")
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
