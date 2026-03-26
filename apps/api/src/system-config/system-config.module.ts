import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigService } from "./system-config.service";
import { SettingsController } from "./settings.controller";

@Module({
  imports: [PrismaModule],
  controllers: [SettingsController],
  providers: [SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
