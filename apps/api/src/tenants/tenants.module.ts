import { Module } from "@nestjs/common";
import { TenantsService } from "./tenants.service";
import { TenantsController } from "./tenants.controller";
import { PublicTenantsController } from "./public-tenants.controller";
import { PublicPlacesController } from "./public-places.controller";
import { TenantGoogleOAuthService } from "./tenant-google-oauth.service";
import { EmailModule } from "../email/email.module";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [EmailModule, StorageModule],
  controllers: [TenantsController, PublicTenantsController, PublicPlacesController],
  providers: [TenantsService, TenantGoogleOAuthService],
  exports: [TenantsService, TenantGoogleOAuthService],
})
export class TenantsModule {}
