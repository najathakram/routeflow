import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigService } from "./system-config.service";
import { SettingsController } from "./settings.controller";
import { QuickKeysRankCache } from "./quick-keys-rank.cache";
import { QuickKeysSettingsService } from "./quick-keys-settings.service";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [PrismaModule, ConfigModule, forwardRef(() => EmailModule)],
  controllers: [SettingsController],
  providers: [SystemConfigService, QuickKeysRankCache, QuickKeysSettingsService],
  exports: [SystemConfigService, QuickKeysRankCache, QuickKeysSettingsService],
})
export class SystemConfigModule {}
