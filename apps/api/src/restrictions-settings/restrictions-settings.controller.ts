import { Body, Controller, Get, Patch, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RestrictionsSettingsService } from "./restrictions-settings.service";
import { UpdateRestrictionsSettingsDto } from "./update-restrictions-settings.dto";

// Reads OPERATOR; the switch and the address policy are TENANT_ADMIN only.
@Controller("settings/restrictions")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RestrictionsSettingsController {
  constructor(private readonly settings: RestrictionsSettingsService) {}

  /** `?readiness=true` also runs the (customer-sweeping) enable-readiness probe. */
  @Get()
  @Roles(UserRole.OPERATOR)
  get(@Query("readiness") readiness?: string) {
    return this.settings.get(readiness === "true");
  }

  @Patch()
  @Roles(UserRole.TENANT_ADMIN)
  update(@Body() dto: UpdateRestrictionsSettingsDto, @CurrentUser() user: JwtPayload) {
    return this.settings.update(dto, user);
  }
}
