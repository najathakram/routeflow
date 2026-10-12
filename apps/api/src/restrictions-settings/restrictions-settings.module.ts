import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisThrottlerStorage } from "../common/redis-throttler.storage";
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
import { RestrictionsSettingsController } from "./restrictions-settings.controller";
import { READINESS_LIMITER, RestrictionsSettingsService } from "./restrictions-settings.service";
import { UnknownStateCustomersController } from "./unknown-state-customers.controller";
import { UnknownStateCustomersService } from "./unknown-state-customers.service";

/** Tenant settings for selling restrictions. Changing them affects nothing until a caller enforces (step 2). */
@Module({
  imports: [SellingRestrictionsModule],
  controllers: [RestrictionsSettingsController, UnknownStateCustomersController],
  providers: [
    RestrictionsSettingsService,
    UnknownStateCustomersService,
    // The repo's own Redis-backed throttler storage (fixed-window INCR), used per tenant.
    {
      provide: READINESS_LIMITER,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => new RedisThrottlerStorage(c),
    },
  ],
})
export class RestrictionsSettingsModule {}
