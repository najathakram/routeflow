import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bull";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";

import { configuration } from "./config/configuration";
import { PrismaModule } from "./prisma/prisma.module";

import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { CustomersModule } from "./customers/customers.module";
import { DriversModule } from "./drivers/drivers.module";
import { ProductsModule } from "./products/products.module";
import { RoutesModule } from "./routes/routes.module";
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
import { ReturnsModule } from "./returns/returns.module";
import { MessagesModule } from "./messages/messages.module";
import { UploadsModule } from "./uploads/uploads.module";
import { SuppliersModule } from "./suppliers/suppliers.module";
import { RecurringInvoicesModule } from "./recurring-invoices/recurring-invoices.module";
import { ImportModule } from "./import/import.module";
import { EmailModule } from "./email/email.module";

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

    // ─── Rate limiting (100 req / 60 s per IP) ────────────────────────────────
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

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
    RoutesModule,
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
    ReturnsModule,
    MessagesModule,
    UploadsModule,
    SuppliersModule,
    RecurringInvoicesModule,
    ImportModule,
    EmailModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
