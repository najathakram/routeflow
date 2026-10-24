import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TenantsService } from "./tenants.service";
import { TenantsController } from "./tenants.controller";
import { PublicTenantsController } from "./public-tenants.controller";
import { PublicPlacesController } from "./public-places.controller";
import { EmailModule } from "../email/email.module";
import { StorageModule } from "../storage/storage.module";
import { BillingModule } from "../billing/billing.module";
import { PolicyModule } from "../policy/policy.module";

@Module({
  imports: [
    EmailModule,
    StorageModule,
    BillingModule,
    PolicyModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("jwt.secret"),
        signOptions: { expiresIn: "24h" },
      }),
    }),
  ],
  controllers: [TenantsController, PublicTenantsController, PublicPlacesController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
