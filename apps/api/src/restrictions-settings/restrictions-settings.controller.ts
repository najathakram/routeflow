import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RestrictionsSettingsService } from "./restrictions-settings.service";
import { UpdateRestrictionsSettingsDto } from "./update-restrictions-settings.dto";

// Reads OPERATOR; the address policy is TENANT_ADMIN (SUPER_ADMIN satisfies it via the RolesGuard hierarchy;
// OPERATOR gets 403). Row 510: the on/off switch and the readiness sweep route are gone.
@Controller("settings/restrictions")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RestrictionsSettingsController {
  constructor(private readonly settings: RestrictionsSettingsService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  get() {
    return this.settings.get();
  }

  @Patch()
  @Roles(UserRole.TENANT_ADMIN)
  update(@Body() dto: UpdateRestrictionsSettingsDto, @CurrentUser() user: JwtPayload) {
    return this.settings.update(dto, user);
  }
}
