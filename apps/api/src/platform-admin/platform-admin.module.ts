import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PlatformAdminController } from "./platform-admin.controller";
import { PlatformAdminService } from "./platform-admin.service";
import { PlatformConfigService } from "./platform-config.service";
import { TenantMirrorService } from "./tenant-mirror.service";
import { PlatformAdminBuyersController } from "./platform-admin-buyers.controller";
import { PlatformAdminBuyersService } from "./platform-admin-buyers.service";
import { AppConfig } from "../config/configuration";
import { EmailModule } from "../email/email.module";
import { BillingModule } from "../billing/billing.module";

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig>) => {
        const jwt = config.get<AppConfig["jwt"]>("jwt")!;
        return {
          secret: jwt.secret,
          signOptions: { expiresIn: jwt.expiresIn as any },
        };
      },
    }),
    EmailModule,
    BillingModule,
  ],
  controllers: [PlatformAdminController, PlatformAdminBuyersController],
  providers: [
    PlatformAdminService,
    PlatformConfigService,
    TenantMirrorService,
    PlatformAdminBuyersService,
  ],
  exports: [PlatformConfigService],
})
export class PlatformAdminModule {}
