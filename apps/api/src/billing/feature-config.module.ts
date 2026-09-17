import { Global, Module } from "@nestjs/common";
import { BillingModule } from "./billing.module";
import { FeatureConfigStore, FEATURE_MODE_PROVIDER } from "./feature-config.store";
import { FeatureConfigService } from "./feature-config.service";
import { FeatureConfigController } from "./feature-config.controller";

/**
 * Feature grants v2 brief C (PR-4). `@Global()` so `FeatureConfigStore` — bound to the optional
 * `FEATURE_MODE_PROVIDER` token — reaches any future consumer (brief A's authority/resolver;
 * `RoutesService`, see `routes/route-dispatch-mode.ts`) without that module having to import
 * this one explicitly, the same way `PrismaModule`/`AuditModule` are global. Imports
 * `BillingModule` for `AddonService`/`EntitlementsService` (the "authority"
 * `FeatureConfigService` injects to check a mode's `requires.allOf`) — one-directional:
 * `BillingModule` does not import this module, so there is no cycle. `FeatureConfigStore` itself
 * takes ONLY `PrismaService` (global, no import needed) — the constructor-cycle guard the brief
 * calls for, so the token's future consumer can safely depend on it.
 */
@Global()
@Module({
  imports: [BillingModule],
  controllers: [FeatureConfigController],
  providers: [
    FeatureConfigStore,
    { provide: FEATURE_MODE_PROVIDER, useExisting: FeatureConfigStore },
    FeatureConfigService,
  ],
  exports: [FeatureConfigStore, FEATURE_MODE_PROVIDER, FeatureConfigService],
})
export class FeatureConfigModule {}
