import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { FeatureConfigService, type FeatureConfigModeState } from "./feature-config.service";

export class SetFeatureConfigDto {
  @IsString() @MinLength(1) mode: string;
  @IsString() @MinLength(1) reason: string;
}

/**
 * Feature grants v2 brief C (PR-4). Platform-admin surface for reading/writing a tenant's
 * per-feature config mode. Deliberately its own controller/file (not added to
 * `PlatformAdminController`, which brief C does not own) — same `@Controller("platform-admin")`
 * prefix, mirroring how `PlatformAdminBuyersController` already shares that prefix from its own
 * file.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("platform-admin")
export class FeatureConfigController {
  constructor(private readonly featureConfig: FeatureConfigService) {}

  @Get("tenants/:id/feature-config/:key")
  @ApiOperation({ summary: "Read a tenant's effective config mode for a feature key" })
  getState(@Param("id") id: string, @Param("key") key: string): Promise<FeatureConfigModeState> {
    return this.featureConfig.getState(id, key);
  }

  @Put("tenants/:id/feature-config/:key")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Set a tenant's config mode for a feature key" })
  async setState(
    @Param("id") id: string,
    @Param("key") key: string,
    @Body() dto: SetFeatureConfigDto,
    @CurrentUser() admin: JwtPayload,
  ): Promise<FeatureConfigModeState> {
    await this.featureConfig.set(id, key, dto.mode, dto.reason, admin.sub);
    return this.featureConfig.getState(id, key);
  }

  @Delete("tenants/:id/feature-config/:key")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Clear a tenant's config mode override, reverting to the registry default",
  })
  async clearState(
    @Param("id") id: string,
    @Param("key") key: string,
    @CurrentUser() admin: JwtPayload,
  ): Promise<FeatureConfigModeState> {
    await this.featureConfig.clear(id, key, "cleared via platform-admin", admin.sub);
    return this.featureConfig.getState(id, key);
  }
}
