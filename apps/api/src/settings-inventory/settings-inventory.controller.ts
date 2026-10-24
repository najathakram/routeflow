import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import type { InventorySettings } from "@routeflow/types";
import { UpdateInventorySettingsDto } from "./settings-inventory.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { SettingsInventoryService } from "./settings-inventory.service";

// Reads OPERATOR; the change is TENANT_ADMIN (SUPER_ADMIN satisfies it via the RolesGuard
// hierarchy; OPERATOR gets 403). The body is validated by the service (a coded 400), so it is
// typed `unknown` here: the global whitelist pipe would otherwise turn extra fields into errors.
@ApiTags("settings")
@ApiBearerAuth()
@Controller("settings/inventory")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SettingsInventoryController {
  constructor(private readonly settings: SettingsInventoryService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  @ApiOperation({ summary: "Inventory & ordering settings (out-of-stock ordering)" })
  get(@CurrentUser() _user: JwtPayload): Promise<InventorySettings> {
    return this.settings.get();
  }

  @Patch()
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "Change out-of-stock ordering (audited policy write)" })
  update(
    @Body() body: UpdateInventorySettingsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InventorySettings> {
    return this.settings.update(body, user);
  }
}
