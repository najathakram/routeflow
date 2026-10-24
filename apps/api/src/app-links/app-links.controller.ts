import { Controller, Get, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AppLinks } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlatformConfigService } from "../platform-admin/platform-config.service";

/**
 * The global "Get the app" install links, readable by every signed-in dashboard role (the super
 * admin edits them at PUT /platform-admin/app-links). The links are not tenant data, so nothing
 * here is tenant-scoped; an unset or invalid link reads as null.
 */
@ApiTags("app-links")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("app-links")
export class AppLinksController {
  constructor(private readonly platformConfig: PlatformConfigService) {}

  @Get()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER)
  @ApiOperation({ summary: "Install links for the mobile app (null = not ready)" })
  get(): Promise<AppLinks> {
    return this.platformConfig.getAppLinks();
  }
}
