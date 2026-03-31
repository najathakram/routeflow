import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigService } from "./system-config.service";
import { SettingsController } from "./settings.controller";

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [SettingsController],
  providers: [SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
