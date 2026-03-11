import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { ZohoSyncService } from "./zoho-sync.service";

@Controller("zoho-sync")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class ZohoSyncController {
  constructor(private readonly zohoSyncService: ZohoSyncService) {}

  @Post()
  triggerSync() {
    return this.zohoSyncService.syncProducts();
  }

  @Get("status")
  getStatus() {
    return this.zohoSyncService.getStatus();
  }

  @Get("config")
  getConfig() {
    return this.zohoSyncService.getConfig();
  }

  @Patch("config")
  updateConfig(
    @Body()
    dto: {
      clientId?: string;
      clientSecret?: string;
      refreshToken?: string;
      region?: string;
    },
  ) {
    return this.zohoSyncService.updateConfig(dto);
  }
}
