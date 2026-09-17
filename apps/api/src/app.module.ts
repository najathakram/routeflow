import { Module, NestModule, MiddlewareConsumer, RequestMethod } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bull";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { RedisThrottlerStorage } from "./common/redis-throttler.storage";

import { configuration } from "./config/configuration";
import { PrismaModule } from "./prisma/prisma.module";
import { CommonModule } from "./common/common.module";
import { TenantModule } from "./tenant/tenant.module";
import { TenantResolutionMiddleware } from "./tenant/tenant-resolution.middleware";
import { TenantsModule } from "./tenants/tenants.module";

import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { CustomersModule } from "./customers/customers.module";
import { DriversModule } from "./drivers/drivers.module";
import { ProductsModule } from "./products/products.module";
import { PromotionsModule } from "./promotions/promotions.module";
import { RoutesModule } from "./routes/routes.module";
import { TripsModule } from "./trips/trips.module";
import { OrdersModule } from "./orders/orders.module";
import { BookkeepingModule } from "./bookkeeping/bookkeeping.module";
import { SystemConfigModule } from "./system-config/system-config.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { RouteOptimizationModule } from "./route-optimization/route-optimization.module";
import { GatewaysModule } from "./gateways/gateways.module";
import { OrderTemplatesModule } from "./order-templates/order-templates.module";
import { InventoryModule } from "./inventory/inventory.module";
import { InvoicesModule } from "./invoices/invoices.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { CreditNotesModule } from "./credit-notes/credit-notes.module";
import { EstimatesModule } from "./estimates/estimates.module";
import { VendorBillsModule } from "./vendor-bills/vendor-bills.module";
import { SupplierStatementsModule } from "./supplier-statements/supplier-statements.module";
import { ReturnsModule } from "./returns/returns.module";
import { MessagesModule } from "./messages/messages.module";
import { MessagingModule } from "./messaging/messaging.module";
import { UploadsModule } from "./uploads/uploads.module";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { RecurringInvoicesModule } from "./recurring-invoices/recurring-invoices.module";
import { ImportModule } from "./import/import.module";
import { EmailModule } from "./email/email.module";
import { PlatformAdminModule } from "./platform-admin/platform-admin.module";
import { AuditModule } from "./audit/audit.module";
import { BillingModule } from "./billing/billing.module";
import { FeatureConfigModule } from "./billing/feature-config.module"; // feature grants v2 brief C (PR-4)
import { StripeConnectModule } from "./stripe-connect/stripe-connect.module";
import { PaymentRequestsModule } from "./payment-requests/payment-requests.module";
import { BuyerModule } from "./buyer/buyer.module";
import { TobaccoModule } from "./tobacco/tobacco.module";
import { DraftsModule } from "./drafts/drafts.module";
import { TrackedCategoriesModule } from "./tracked-categories/tracked-categories.module";
import { RegulatedModule } from "./regulated/regulated.module";
import { AuthorizationsModule } from "./authorizations/authorizations.module";
import { CommissionsModule } from "./sales-agents/commissions.module";
import { CrmModule } from "./crm/crm.module";
import { DemoBookingModule } from "./demo-booking/demo-booking.module";

import { TenantStatusGuard } from "./tenant/tenant-status.guard";
import { ImpersonationGuard } from "./auth/guards/impersonation.guard";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";

@Module({
  imports: [
    // ─── Config (global) ──────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // ─── Prisma (global) ──────────────────────────────────────────────────────
    PrismaModule,

    // ─── Common utilities (global) ────────────────────────────────────────────
    CommonModule,

    // ─── Tenant isolation (global) ────────────────────────────────────────────
    TenantModule,
    TenantsModule,

    // ─── Rate limiting (100 req / 60 s per IP, Redis-backed across all instances)
    // forRootAsync with storage option is required — forRoot([...]) (array format)
    // always creates a new in-memory ThrottlerStorageService(), ignoring any
    // custom storage override. Only the object format honours options.storage.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: new RedisThrottlerStorage(config),
      }),
    }),

    // ─── Redis queue ──────────────────────────────────────────────────────────
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const rawUrl = config.get<string>("redis.url") ?? "redis://localhost:6379";
        let redisUrl: URL;
        try {
          redisUrl = new URL(rawUrl);
        } catch {
          redisUrl = new URL("redis://localhost:6379");
        }
        const password = config.get<string>("redis.password");
        return {
          redis: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port || 6379),
            ...(password ? { password } : {}),
          },
        };
      },
    }),

    // ─── Cron scheduler ───────────────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ─── Feature modules ──────────────────────────────────────────────────────
    AuthModule,
    UsersModule,
    CustomersModule,
    DriversModule,
    ProductsModule,
    PromotionsModule,
    RoutesModule,
    TripsModule,
    OrdersModule,
    BookkeepingModule,
    SystemConfigModule,
    NotificationsModule,
    RouteOptimizationModule,
    GatewaysModule,
    OrderTemplatesModule,
    InventoryModule,
    // ─── Zoho-parity new modules ──────────────────────────────────────────────
    InvoicesModule,
    AnalyticsModule,
    CreditNotesModule,
    EstimatesModule,
    VendorBillsModule,
    SupplierStatementsModule,
    ReturnsModule,
    MessagesModule,
    MessagingModule,
    UploadsModule,
    SuppliersModule,
    RecurringInvoicesModule,
    ImportModule,
    EmailModule,
    // ─── Platform administration + audit (global) ─────────────────────────────
    PlatformAdminModule,
    AuditModule,
    // ─── Billing (Stripe) ──────────────────────────────────────────────────────
    BillingModule,
    FeatureConfigModule,
    // ─── Stripe Connect (tenant's own account) + buyer payment requests ────────
    StripeConnectModule,
    PaymentRequestsModule,
    // ─── Buyer Portal (multi-tenant customer identity) ─────────────────────────
    BuyerModule,
    // ─── Tobacco compliance (tobacco_dealer addon) ─────────────────────────────
    TobaccoModule,
    // ─── Minimize & resume drafts (pos-cost-roles-spec §2) ─────────────────────
    DraftsModule,
    // ─── Regulated / tracked categories (Phase 4) ──────────────────────────────
    TrackedCategoriesModule,
    RegulatedModule,
    AuthorizationsModule,
    // ─── Sales agents & commissions (flag.sales_agents) ───────────────────────
    CommissionsModule,
    CrmModule,
    DemoBookingModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // ─── Guard-order invariant (do not reorder without a security review) ─────
    // These APP_GUARD providers are global and run on EVERY request, before
    // JwtAuthGuard — which is applied per-route, by design, not globally. At
    // this point in the pipeline any JWT claims are UNVERIFIED: a global guard
    // may read them only to throttle or look up state (e.g. tenant status by
    // an unverified tenantId), NEVER to authorize a request or grant access.
    // Real authorization happens later, per-route, once JwtAuthGuard has
    // verified the token. Changing this order, or adding a new global guard
    // that authorizes based on unverified claims, is a security-sensitive
    // change and must be reviewed as one.
    // Global throttle: 100 req / 60 s per IP on every endpoint
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Block SUSPENDED / CANCELLED tenants from making any API calls.
    // useExisting ensures the same singleton instance used by PlatformAdminService
    // (for cache invalidation) is the one that runs as the global guard.
    { provide: APP_GUARD, useExisting: TenantStatusGuard },
    // ImpersonationGuard — kept as a no-op for the `impersonatedBy` audit trail;
    // impersonation sessions have full write access (same as the impersonated user).
    { provide: APP_GUARD, useClass: ImpersonationGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantResolutionMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
