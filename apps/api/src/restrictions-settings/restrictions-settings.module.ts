import { Module } from "@nestjs/common";
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
import { RestrictionsSettingsController } from "./restrictions-settings.controller";
import { RestrictionsSettingsService } from "./restrictions-settings.service";
import { UnknownStateBulkService } from "./unknown-state-bulk.service";
import { UnknownStateCustomersController } from "./unknown-state-customers.controller";
import { UnknownStateCustomersService } from "./unknown-state-customers.service";

/** Tenant settings for selling restrictions (the governing-address policy and the customers-without-a-state sweep). */
@Module({
  imports: [SellingRestrictionsModule],
  controllers: [RestrictionsSettingsController, UnknownStateCustomersController],
  providers: [RestrictionsSettingsService, UnknownStateCustomersService, UnknownStateBulkService],
})
export class RestrictionsSettingsModule {}
