import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigService } from "./system-config.service";
import { SettingsController } from "./settings.controller";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [PrismaModule, ConfigModule, forwardRef(() => EmailModule)],
  controllers: [SettingsController],
  providers: [SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
