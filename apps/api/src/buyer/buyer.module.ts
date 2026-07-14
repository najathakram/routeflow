import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { AppConfig } from "../config/configuration";
import { EmailModule } from "../email/email.module";
import { TenantModule } from "../tenant/tenant.module";
import { OrdersModule } from "../orders/orders.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { CustomersModule } from "../customers/customers.module";
import { ProductsModule } from "../products/products.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { OrderTemplatesModule } from "../order-templates/order-templates.module";
import { StorageModule } from "../storage/storage.module";
import { AuthorizationsModule } from "../authorizations/authorizations.module";
import { StockAlertsModule } from "../stock-alerts/stock-alerts.module";
import { SystemConfigModule } from "../system-config/system-config.module";

import { BuyerAuthController } from "./buyer-auth.controller";
import { BuyerController } from "./buyer.controller";
import { BuyerAdminController, CustomerLinksAdminController } from "./buyer-admin.controller";
import { BuyerMergeController } from "./buyer-merge.controller";
import { BuyerAdminMergeController } from "./buyer-admin-merge.controller";

import { BuyerAuthService } from "./buyer-auth.service";
import { BuyerService } from "./buyer.service";
import { BuyerAdminService } from "./buyer-admin.service";
import { BuyerMergeService } from "./buyer-merge.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";

import { BuyerJwtStrategy } from "./strategies/buyer-jwt.strategy";
import { BuyerJwtAuthGuard } from "./guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "./guards/buyer-seller-context.guard";
import { BuyerTenantInterceptor } from "./buyer-tenant.interceptor";

@Module({
  imports: [
    PassportModule,
    EmailModule,
    TenantModule,
    OrdersModule,
    InvoicesModule,
    CustomersModule,
    ProductsModule,
    PromotionsModule,
    OrderTemplatesModule,
    StorageModule,
    AuthorizationsModule,
    StockAlertsModule,
    SystemConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig>) => ({
        secret: configService.get<AppConfig["jwt"]>("jwt")?.secret,
        signOptions: {
          expiresIn: configService.get<AppConfig["jwt"]>("jwt")?.expiresIn as any,
        },
      }),
    }),
  ],
  controllers: [
    BuyerAuthController,
    BuyerController,
    BuyerAdminController,
    CustomerLinksAdminController,
    BuyerMergeController,
    BuyerAdminMergeController,
  ],
  providers: [
    Reflector,
    BuyerAuthService,
    BuyerService,
    BuyerAdminService,
    BuyerMergeService,
    BuyerCatalogService,
    BuyerDashboardService,
    RegulatedVisibilityService,
    ReplenishmentService,
    ShelfService,
    StatementService,
    StatementPdfService,
    BuyerJwtStrategy,
    BuyerJwtAuthGuard,
    BuyerSellerContextGuard,
    BuyerTenantInterceptor,
  ],
  exports: [BuyerAuthService, BuyerService, BuyerJwtAuthGuard, BuyerSellerContextGuard],
})
export class BuyerModule {}
