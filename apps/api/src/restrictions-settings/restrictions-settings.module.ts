import { Module } from "@nestjs/common";
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { RestrictionsSettingsController } from "./restrictions-settings.controller";
import { RestrictionsSettingsService } from "./restrictions-settings.service";

/** Tenant settings for selling restrictions. Changing them affects nothing until a caller enforces (step 2). */
@Module({
  imports: [SellingRestrictionsModule, SystemConfigModule],
  controllers: [RestrictionsSettingsController],
  providers: [RestrictionsSettingsService],
})
export class RestrictionsSettingsModule {}
