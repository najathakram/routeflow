import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { TenantContextService } from "./tenant-context.service";
import { TenantInterceptor } from "./tenant.interceptor";
import { SuperAdminGuard } from "./super-admin.guard";
import { TenantStatusGuard } from "./tenant-status.guard";

/**
 * Global module providing tenant context to the entire application.
 * Import once in AppModule — TenantContextService is available everywhere.
 */
@Global()
@Module({
  providers: [
    TenantContextService,
    SuperAdminGuard,
    TenantStatusGuard,
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantInterceptor,
    },
  ],
  exports: [TenantContextService, SuperAdminGuard, TenantStatusGuard],
})
export class TenantModule {}
